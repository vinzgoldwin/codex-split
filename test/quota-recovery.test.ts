import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { sha256 } from '../worker/crypto';
import { contributions, DAY, repriceBatch, summaryStatements } from '../worker/batches';
import { recordQuota } from '../worker/index';
import { PRICING_VERSION } from '../worker/pricing';
import type { RequestUsage } from '../worker/types';

beforeEach(async () => {
    await env.DB.batch([
        env.DB.prepare('DELETE FROM usage_batches'),
        env.DB.prepare('DELETE FROM quota_windows'),
        env.DB.prepare('DELETE FROM member_usage_days'),
    ]);
});

it('recovers requests uploaded before a quota reading without duplicating totals or moving stale quota', async () => {
    const now = Date.now();
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO devices (id, member_id, token_hash, name, platform, created_at) VALUES (?, 1, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), await sha256(token), 'recovery-test', 'linux', now)
        .run();
    const send = (data: object) =>
        SELF.fetch('https://split.test/api/sync', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ protocol: 2, agent_version: '0.2.0', batch_id: crypto.randomUUID(), ...data }),
        });
    const usage = {
        model: 'gpt-6-astra',
        input_tokens: 1000,
        cached_input_tokens: 500,
        output_tokens: 100,
        service_tier: 'default',
        recorded_at: new Date(now - 60_000).toISOString(),
    };
    expect((await send({ sequence: 1, usage: [usage] })).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM quota_window_members').first()).toEqual({ count: 0 });

    const quota = {
        used_percent: 8,
        window_duration_mins: 10_080,
        resets_at: new Date(now + DAY).toISOString(),
        sampled_at: new Date(now).toISOString(),
    };
    // Window discovery and two overlapping reconciliations must still count the batch once.
    await recordQuota(env, quota);
    await Promise.all([repriceBatch(env), repriceBatch(env)]);
    expect(await repriceBatch(env)).toBe(false);
    const payload = { sequence: 2, batch_id: crypto.randomUUID(), usage: [], quota };
    expect((await send(payload)).status).toBe(200);
    expect((await send(payload)).status).toBe(200);
    const totals = () => env.DB.prepare('SELECT input_tokens, output_tokens, usage_weight FROM quota_window_members WHERE member_id = 1').first();
    expect(await totals()).toEqual({ input_tokens: 1000, output_tokens: 100, usage_weight: 10_500 });
    expect(await env.DB.prepare('SELECT input_tokens, output_tokens FROM member_usage_days WHERE member_id = 1').first()).toEqual({
        input_tokens: 1000,
        output_tokens: 100,
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM quota_samples').first()).toEqual({ count: 1 });

    // Late and repeated readings stay available for audits but do not replace a newer reading.
    const stale = { ...quota, used_percent: 7, sampled_at: new Date(now - 1000).toISOString() };
    expect((await send({ sequence: 3, usage: [], quota: stale })).status).toBe(200);
    expect((await send({ sequence: 4, usage: [], quota: stale })).status).toBe(200);
    expect(await env.DB.prepare('SELECT used_percent FROM quota_windows').first()).toEqual({ used_percent: 8 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM quota_samples').first()).toEqual({ count: 2 });
    expect(await totals()).toEqual({ input_tokens: 1000, output_tokens: 100, usage_weight: 10_500 });
});

it('does not repeatedly reconcile a batch that straddles the start of the only known window', async () => {
    const now = Date.now();
    const start = Math.floor(now / DAY) * DAY - DAY + 12 * 60 * 60_000;
    const window = await recordQuota(env, {
        used_percent: 1,
        sampled_at: new Date(now).toISOString(),
        resets_at: new Date(start + 7 * DAY).toISOString(),
        window_duration_mins: 10_080,
    });
    const device = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO devices (id, member_id, token_hash, name, platform, created_at) VALUES (?, 1, ?, ?, ?, ?)')
        .bind(device, crypto.randomUUID(), 'boundary-test', 'linux', now)
        .run();
    const usage: RequestUsage[] = [-1, 0].map((offset) => ({
        model: 'gpt-6-astra',
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 10,
        reasoning_output_tokens: 0,
        service_tier: 'default',
        recorded_at: new Date(start + offset).toISOString(),
    }));
    const rows = contributions(usage, [window], now);
    expect(rows.map((row) => row.window)).toEqual([null, window.id]);
    await env.DB.batch([
        ...summaryStatements(env, 1, rows, '1 = 1', []),
        env.DB.prepare(
            `INSERT INTO usage_batches (device_id, member_id, batch_id, sequence, usage_json, contributions_json, pricing_version, created_at)
             VALUES (?, 1, ?, 1, ?, ?, ?, ?)`,
        ).bind(device, crypto.randomUUID(), JSON.stringify(usage), JSON.stringify(rows), PRICING_VERSION, now),
    ]);
    expect(await repriceBatch(env)).toBe(false);
});
