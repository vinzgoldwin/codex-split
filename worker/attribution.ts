import { estimateUsageWeight } from './pricing';
import type { Env, RequestUsage } from './types';

interface Interval {
    id: number;
    quota_window_id: number;
    starts_at: number;
    ends_at: number;
    used_percent: number;
}

interface Activity {
    weight: number;
    tokens: number;
    unknown: number;
}

/** Finalize a bounded number of quota increases after collectors have had time to report. */
export async function settleQuota(env: Env, now = Date.now()): Promise<void> {
    const intervals = await env.DB.prepare('SELECT * FROM quota_intervals WHERE finalized_at IS NULL AND settle_after <= ? ORDER BY id LIMIT 8')
        .bind(now)
        .all<Interval>();

    for (const interval of intervals.results) {
        const activity = new Map<number, Activity>();
        const add = (member: number, weight: number, tokens: number, unknown: number) => {
            const previous = activity.get(member) || { weight: 0, tokens: 0, unknown: 0 };
            activity.set(member, { weight: previous.weight + weight, tokens: previous.tokens + tokens, unknown: previous.unknown + unknown });
        };
        // Protocol 1 uses its quota sample or upload time; protocol 2 retains request timestamps.
        const legacy = await env.DB.prepare(
            `SELECT member_id, SUM(estimated_cost_micros) AS weight,
                    SUM(input_tokens + output_tokens) AS tokens,
                    SUM(CASE WHEN estimated_cost_micros = 0 THEN 1 ELSE 0 END) AS unknown
             FROM usage_entries WHERE reported_at > ? AND reported_at <= ? GROUP BY member_id`,
        )
            .bind(interval.starts_at, interval.ends_at)
            .all<Activity & { member_id: number }>();
        for (const row of legacy.results) add(row.member_id, row.weight, row.tokens, row.unknown);

        // Page the bounded uploads so an offline backlog never fills Worker memory.
        let after = 0;
        for (;;) {
            const batches = await env.DB.prepare(
                `SELECT id, member_id, usage_json FROM usage_batches
                 WHERE id > ? AND created_at >= ? AND created_at <= ? ORDER BY id LIMIT 64`,
            )
                .bind(after, interval.starts_at - 5 * 60_000, now)
                .all<{ id: number; member_id: number; usage_json: string }>();
            for (const batch of batches.results) {
                for (const usage of JSON.parse(batch.usage_json) as RequestUsage[]) {
                    const at = Date.parse(usage.recorded_at);
                    if (at <= interval.starts_at || at > interval.ends_at) continue;
                    const tokens = usage.input_tokens + usage.output_tokens;
                    const weight = estimateUsageWeight(usage);
                    add(batch.member_id, weight, tokens, tokens > 0 && weight === 0 ? 1 : 0);
                }
            }
            if (batches.results.length < 64) break;
            after = batches.results.at(-1)!.id;
        }
        const useWeight = [...activity.values()].every((row) => row.unknown === 0);
        const total = [...activity.values()].reduce((sum, row) => sum + (useWeight ? row.weight : row.tokens), 0);
        const statements: D1PreparedStatement[] = [];
        for (const [member, row] of activity) {
            if (total <= 0) break;
            const used = (interval.used_percent * (useWeight ? row.weight : row.tokens)) / total;
            if (used <= 0) continue;
            statements.push(
                env.DB.prepare(
                    `INSERT INTO quota_window_members (quota_window_id, member_id, allocation_percent, used_percent)
                 SELECT ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM quota_intervals WHERE id = ? AND finalized_at IS NULL)
                 ON CONFLICT(quota_window_id, member_id) DO UPDATE SET used_percent = used_percent + excluded.used_percent`,
                ).bind(interval.quota_window_id, member, used, interval.id),
            );
        }
        // This atomic guard prevents concurrent syncs or dashboard reads from allocating twice.
        statements.push(env.DB.prepare('UPDATE quota_intervals SET finalized_at = ? WHERE id = ? AND finalized_at IS NULL').bind(now, interval.id));
        await env.DB.batch(statements);
    }
}
