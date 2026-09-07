import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { sha256 } from '../worker/crypto';
import { recordQuota } from '../worker/index';
import { DAY } from '../worker/batches';
import type { DashboardData } from '../src/types';

it('counts legacy uploads once while keeping account quota unattributed', async () => {
    const now = Date.now();
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO devices (id, member_id, token_hash, name, platform, created_at) VALUES (?, 1, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), await sha256(token), 'legacy-interval', 'windows', now)
        .run();
    const quota = (used: number, offset: number) => ({
        used_percent: used,
        window_duration_mins: 10080,
        resets_at: new Date(now + 3 * DAY).toISOString(),
        sampled_at: new Date(now + offset).toISOString(),
    });
    const window = await recordQuota(env, quota(10, 0));
    const body = {
        batch_id: crypto.randomUUID(),
        reported_at: new Date(now + 2001).toISOString(),
        agent_version: '0.1.0',
        usage: [{ model: 'gpt-5.6-sol', input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 }],
        quota: quota(12, 2000),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await SELF.fetch('https://split.test/api/sync', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        expect(result.status).toBe(200);
    }
    const used = () =>
        env.DB.prepare(
            `SELECT used_percent, input_tokens, output_tokens, estimated_cost_micros
             FROM quota_window_members WHERE quota_window_id = ? AND member_id = 1`,
        )
            .bind(window.id)
            .first();
    const expected = { used_percent: 0, input_tokens: 1000, output_tokens: 100, estimated_cost_micros: 6000 };
    expect(await used()).toEqual(expected);
    await recordQuota(env, quota(14, 3000));
    expect(await used()).toEqual(expected);

    const login = await SELF.fetch('https://split.test/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 1, password: 'Akashi' }),
    });
    expect(login.status).toBe(200);
    const result = await SELF.fetch('https://split.test/api/dashboard', {
        headers: { Cookie: login.headers.get('Set-Cookie')!.split(';')[0] },
    });
    expect(result.status).toBe(200);
    const data = (await result.json()) as DashboardData;
    expect(data.account).toMatchObject({ used: 14, unattributed: 14 });
    expect(data.members.find((member) => member.id === 1)).toMatchObject({ used: 0, shareUsed: 0, weeklyTokens: 1100, weeklyCost: 0.006 });
});
