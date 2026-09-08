import { estimateRequestMicros, estimateUsageWeight, PRICING_VERSION } from './pricing';
import type { Env, QuotaWindowRow, RequestUsage } from './types';

export const DAY = 86_400_000;
export interface Contribution {
    day: number;
    window: number | null;
    cost: number;
    weight: number;
    input: number;
    output: number;
    unknown: number;
    incomplete: number;
}

export function contributions(usages: RequestUsage[], windows: QuotaWindowRow[], now: number): Contribution[] {
    const groups = new Map<string, Contribution>();
    for (const usage of usages) {
        const at = Date.parse(usage.recorded_at);
        const day = Math.floor(at / DAY) * DAY;
        if (day < Math.floor(now / DAY) * DAY - 29 * DAY) continue;
        const window = windows.find((w) => at >= w.reset_at - w.duration_minutes * 60_000 && at < w.reset_at)?.id ?? null;
        const key = `${day}:${window}`;
        const row = groups.get(key) || { day, window, cost: 0, weight: 0, input: 0, output: 0, unknown: 0, incomplete: 0 };
        const cost = estimateRequestMicros(usage);
        row.cost += cost;
        row.weight += estimateUsageWeight(usage);
        row.input += usage.input_tokens;
        row.output += usage.output_tokens;
        row.unknown += cost === 0 && usage.input_tokens + usage.output_tokens > 0 ? 1 : 0;
        row.incomplete += cost === 0 || !['default', 'fast', 'priority'].includes(usage.service_tier) ? 1 : 0;
        groups.set(key, row);
    }
    return [...groups.values()];
}

// The final device checkpoint makes every statement in this atomic batch idempotent.
export function summaryStatements(
    env: Env,
    member: number,
    rows: Contribution[],
    guard: string,
    guardArgs: (string | number)[],
): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
        statements.push(
            env.DB.prepare(
                `INSERT INTO member_usage_days
            (member_id, day_start, estimated_cost_micros, input_tokens, output_tokens, unknown_entries, incomplete_entries)
            SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
            ON CONFLICT(member_id, day_start) DO UPDATE SET
            estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens,
            unknown_entries = unknown_entries + excluded.unknown_entries,
            incomplete_entries = incomplete_entries + excluded.incomplete_entries`,
            ).bind(member, row.day, row.cost, row.input, row.output, row.unknown, row.incomplete, ...guardArgs),
        );
        if (row.window !== null) {
            statements.push(
                env.DB.prepare(
                    `INSERT INTO quota_window_members
                (quota_window_id, member_id, allocation_percent, estimated_cost_micros, usage_weight, input_tokens, output_tokens, unknown_entries, incomplete_entries)
                SELECT ?, ?, 0, ?, ?, ?, ?, ?, ? WHERE ${guard}
                ON CONFLICT(quota_window_id, member_id) DO UPDATE SET
                estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
                usage_weight = usage_weight + excluded.usage_weight,
                input_tokens = input_tokens + excluded.input_tokens,
                output_tokens = output_tokens + excluded.output_tokens,
                unknown_entries = unknown_entries + excluded.unknown_entries,
            incomplete_entries = incomplete_entries + excluded.incomplete_entries`,
                ).bind(row.window, member, row.cost, row.weight, row.input, row.output, row.unknown, row.incomplete, ...guardArgs),
            );
        }
    }
    return statements;
}

/** Reconcile one retained batch's prices or newly discovered quota window. */
export async function repriceBatch(env: Env): Promise<boolean> {
    const batch = await env.DB.prepare(
        `SELECT * FROM usage_batches WHERE pricing_version != ? OR (
            EXISTS (SELECT 1 FROM json_each(contributions_json) WHERE json_extract(value, '$.window') IS NULL)
            AND EXISTS (
                SELECT 1 FROM json_each(usage_json) u JOIN quota_windows w
                ON json_extract(u.value, '$.recorded_at') >= strftime('%Y-%m-%dT%H:%M:%fZ', (w.reset_at - w.duration_minutes * 60000) / 1000.0, 'unixepoch')
                AND json_extract(u.value, '$.recorded_at') < strftime('%Y-%m-%dT%H:%M:%fZ', w.reset_at / 1000.0, 'unixepoch')
                WHERE NOT EXISTS (SELECT 1 FROM json_each(contributions_json) c WHERE json_extract(c.value, '$.window') = w.id)
            )
        ) ORDER BY id LIMIT 1`,
    )
        .bind(PRICING_VERSION)
        .first<{ id: number; member_id: number; usage_json: string; contributions_json: string; pricing_version: string }>();
    if (!batch) return false;
    const windows = await env.DB.prepare('SELECT * FROM quota_windows ORDER BY sampled_at DESC').all<QuotaWindowRow>();
    const previous = JSON.parse(batch.contributions_json) as Contribution[];
    const next = contributions(JSON.parse(batch.usage_json) as RequestUsage[], windows.results, Date.now());
    const delta = new Map<string, Contribution>();
    for (const [rows, sign] of [
        [previous, -1],
        [next, 1],
    ] as const) {
        for (const row of rows) {
            if (row.day < Math.floor(Date.now() / DAY) * DAY - 29 * DAY) continue;
            const key = `${row.day}:${row.window}`;
            const item = delta.get(key) || { ...row, cost: 0, weight: 0, input: 0, output: 0, unknown: 0, incomplete: 0 };
            for (const field of ['cost', 'weight', 'input', 'output', 'unknown', 'incomplete'] as const) item[field] += sign * row[field];
            delta.set(key, item);
        }
    }
    // A window-only correction keeps the price version, so compare the old contributions too.
    const guard = 'EXISTS (SELECT 1 FROM usage_batches WHERE id = ? AND pricing_version = ? AND contributions_json = ?)';
    const guardArgs = [batch.id, batch.pricing_version, batch.contributions_json];
    await env.DB.batch([
        ...summaryStatements(env, batch.member_id, [...delta.values()], guard, guardArgs),
        env.DB.prepare(
            'UPDATE usage_batches SET contributions_json = ?, pricing_version = ? WHERE id = ? AND pricing_version = ? AND contributions_json = ?',
        ).bind(JSON.stringify(next), PRICING_VERSION, ...guardArgs),
    ]);
    return true;
}
