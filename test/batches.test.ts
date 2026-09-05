import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../worker/crypto';
import { DAY, repriceBatch } from '../worker/batches';
import { PRICING_VERSION, estimateRequestMicros, estimateUsageWeight } from '../worker/pricing';
import { prune } from '../worker/index';
import type { RequestUsage } from '../worker/types';

const sample: RequestUsage = {
    model: 'gpt-6-astra',
    input_tokens: 300_000,
    cached_input_tokens: 100_000,
    cache_write_input_tokens: 20_000,
    output_tokens: 10_000,
    reasoning_output_tokens: 5_000,
    service_tier: 'priority',
    recorded_at: new Date().toISOString(),
};

describe('request pricing', () => {
    it('combines long-context, cache writes and fast rates without adding reasoning twice', () => {
        // (180k * 10 + 100k * 1 + 20k * 12.5) * 2 + 10k * 50 * 1.5, then fast.
        expect(estimateRequestMicros(sample)).toBe(10_100_000);
        expect(estimateUsageWeight(sample)).toBe(12_625_000);
        expect(estimateRequestMicros({ ...sample, reasoning_output_tokens: 0 })).toBe(10_100_000);
    });
    it('uses request size rather than batch size and honors the exact threshold', () => {
        const row = { ...sample, input_tokens: 272_000, service_tier: 'default' };
        expect(estimateRequestMicros(row)).toBe(2_370_000);
        expect(estimateRequestMicros({ ...row, input_tokens: 272_001 })).toBe(4_490_020);
        expect(estimateRequestMicros({ ...row, model: 'future-model' })).toBe(0);
        expect(estimateRequestMicros({ ...row, model: 'gpt-5.6' })).toBe(estimateRequestMicros({ ...row, model: 'gpt-5.6-sol' }));
    });
});

it('stores one batch, attributes event dates, deduplicates retries after pruning, and reprices retained records', async () => {
    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now = Date.now();
    const reset = now + 2 * DAY;
    await env.DB.prepare('INSERT INTO devices (id, member_id, token_hash, name, platform, created_at) VALUES (?, 1, ?, ?, ?, ?)')
        .bind(id, await sha256(token), 'batch-test', 'linux', now)
        .run();
    const window = await env.DB.prepare(
        `INSERT INTO quota_windows
        (reset_at, duration_minutes, used_percent, baseline_used_percent, sampled_at, created_at)
        VALUES (?, 10080, 20, 10, ?, ?) RETURNING id`,
    )
        .bind(reset, now, now)
        .first<{ id: number }>();
    const at = new Date(now - DAY).toISOString();
    const payload = {
        protocol: 2,
        sequence: 1,
        batch_id: crypto.randomUUID(),
        agent_version: '0.2.0',
        usage: [
            { ...sample, recorded_at: at },
            { ...sample, recorded_at: at, service_tier: 'default' },
        ],
    };
    const send = (body: unknown) =>
        SELF.fetch('https://split.test/api/sync', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    expect((await send(payload)).status).toBe(200);
    const before = await env.DB.prepare(
        'SELECT estimated_cost_micros AS cost, usage_weight AS weight FROM quota_window_members WHERE quota_window_id = ? AND member_id = 1',
    )
        .bind(window!.id)
        .first();
    expect(before).toEqual({ cost: 15_150_000, weight: 17_675_000 });
    const yesterday = Math.floor((now - DAY) / DAY) * DAY;
    expect(
        await env.DB.prepare('SELECT estimated_cost_micros AS cost FROM member_usage_days WHERE member_id = 1 AND day_start = ?')
            .bind(yesterday)
            .first(),
    ).toEqual({ cost: 15_150_000 });
    expect((await send(payload)).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM usage_batches WHERE device_id = ?').bind(id).first()).toEqual({ count: 1 });
    expect((await send({ ...payload, sequence: 3 })).status).toBe(409);
    expect((await send({ ...payload, sequence: 2, usage: [{ ...sample, cached_input_tokens: 999_999 }] })).status).toBe(422);
    expect((await send({ ...payload, sequence: 2, usage: [sample, { ...sample, recorded_at: at }] })).status).toBe(422);
    // A rate-version correction must alter summaries exactly once.
    const batch = await env.DB.prepare('SELECT id, contributions_json FROM usage_batches WHERE device_id = ?')
        .bind(id)
        .first<{ id: number; contributions_json: string }>();
    const previous = JSON.parse(batch!.contributions_json);
    previous[0].cost -= 100;
    await env.DB.prepare('UPDATE usage_batches SET pricing_version = ?, contributions_json = ? WHERE id = ?')
        .bind('old', JSON.stringify(previous), batch!.id)
        .run();
    await env.DB.prepare(
        'UPDATE quota_window_members SET estimated_cost_micros = estimated_cost_micros - 100 WHERE quota_window_id = ? AND member_id = 1',
    )
        .bind(window!.id)
        .run();
    await env.DB.prepare('UPDATE member_usage_days SET estimated_cost_micros = estimated_cost_micros - 100 WHERE day_start = ? AND member_id = 1')
        .bind(yesterday)
        .run();
    expect(await repriceBatch(env)).toBe(true);
    expect(await repriceBatch(env)).toBe(false);
    expect(await env.DB.prepare('SELECT pricing_version FROM usage_batches WHERE id = ?').bind(batch!.id).first()).toEqual({
        pricing_version: PRICING_VERSION,
    });
    expect(
        await env.DB.prepare(
            'SELECT estimated_cost_micros AS cost, usage_weight AS weight FROM quota_window_members WHERE quota_window_id = ? AND member_id = 1',
        )
            .bind(window!.id)
            .first(),
    ).toEqual(before);
    await env.DB.prepare('UPDATE usage_batches SET created_at = ? WHERE id = ?')
        .bind(now - 8 * DAY, batch!.id)
        .run();
    await prune(env);
    expect((await send(payload)).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM usage_batches WHERE device_id = ?').bind(id).first()).toEqual({ count: 0 });
    expect(
        await env.DB.prepare(
            'SELECT estimated_cost_micros AS cost, usage_weight AS weight FROM quota_window_members WHERE quota_window_id = ? AND member_id = 1',
        )
            .bind(window!.id)
            .first(),
    ).toEqual(before);
});
