import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { sha256 } from '../worker/crypto';
import { DAY } from '../worker/batches';
import type { ModelCost } from '../src/types';

it('shows current-window model costs for one member, including legacy reports', async () => {
    const now = Date.now();
    const reset = now + 2 * DAY;
    const start = reset - 7 * DAY;
    const token = crypto.randomUUID();
    const device = crypto.randomUUID();
    const otherDevice = crypto.randomUUID();
    await env.DB.batch([
        env.DB.prepare('INSERT INTO devices (id, member_id, token_hash, name, platform, created_at) VALUES (?, 1, ?, ?, ?, ?)').bind(
            device,
            await sha256(token),
            'model-breakdown',
            'linux',
            now,
        ),
        env.DB.prepare(
            `INSERT INTO quota_windows (reset_at, duration_minutes, used_percent, baseline_used_percent, sampled_at, created_at)
             VALUES (?, 10080, 10, 10, ?, ?)`,
        ).bind(reset, now, now),
        env.DB.prepare('INSERT INTO devices (id, member_id, token_hash, name, platform, created_at) VALUES (?, 2, ?, ?, ?, ?)').bind(
            otherDevice,
            await sha256(crypto.randomUUID()),
            'other-model-breakdown',
            'linux',
            now,
        ),
    ]);

    const usage = {
        input_tokens: 1_000,
        cached_input_tokens: 200,
        cache_write_input_tokens: 0,
        output_tokens: 100,
        reasoning_output_tokens: 0,
        service_tier: 'default',
        recorded_at: new Date(now - DAY).toISOString(),
    };
    const sync = await SELF.fetch('https://split.test/api/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            protocol: 2,
            sequence: 1,
            batch_id: crypto.randomUUID(),
            agent_version: '0.2.0',
            usage: [
                { ...usage, model: 'gpt-6-sol' },
                { ...usage, model: 'gpt-6-luna' },
            ],
        }),
    });
    expect(sync.status).toBe(200);

    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO usage_entries
             (device_id, member_id, batch_id, model, input_tokens, output_tokens, estimated_cost_micros, reported_at, created_at)
             VALUES (?, 1, ?, 'gpt-5.6-sol', 1000, 100, 6000, ?, ?)`,
        ).bind(device, crypto.randomUUID(), now, now),
        env.DB.prepare(
            `INSERT INTO usage_entries
             (device_id, member_id, batch_id, model, input_tokens, output_tokens, estimated_cost_micros, reported_at, created_at)
             VALUES (?, 1, ?, 'outside-window', 1000, 100, 10000, ?, ?)`,
        ).bind(device, crypto.randomUUID(), start - 1, now),
        env.DB.prepare(
            `INSERT INTO usage_entries
             (device_id, member_id, batch_id, model, input_tokens, output_tokens, estimated_cost_micros, reported_at, created_at)
             VALUES (?, 2, ?, 'other-member', 1000, 100, 10000, ?, ?)`,
        ).bind(otherDevice, crypto.randomUUID(), now, now),
    ]);

    expect((await SELF.fetch('https://split.test/api/members/1/models')).status).toBe(401);
    const login = await SELF.fetch('https://split.test/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 1, password: 'Akashi' }),
    });
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const result = await SELF.fetch('https://split.test/api/members/1/models', { headers: { Cookie: cookie } });
    expect(result.status).toBe(200);
    const { models } = (await result.json()) as { models: ModelCost[] };
    expect(models).toEqual([
        { model: 'gpt-5.6-sol', cost: 0.006, tokens: 1100, incomplete: true },
        { model: 'gpt-6-sol', cost: 0.00264, tokens: 1100, incomplete: false },
        { model: 'gpt-6-luna', cost: 0.000132, tokens: 1100, incomplete: false },
    ]);
});
