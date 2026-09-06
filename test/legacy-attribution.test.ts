import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { sha256 } from '../worker/crypto';
import { settleQuota } from '../worker/attribution';
import { recordQuota } from '../worker/index';
import { DAY } from '../worker/batches';

it('attributes legacy uploads once and leaves an idle legacy member unchanged', async () => {
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
    await settleQuota(env, now + DAY);
    const used = () =>
        env.DB.prepare('SELECT used_percent FROM quota_window_members WHERE quota_window_id = ? AND member_id = 1').bind(window.id).first();
    expect(await used()).toEqual({ used_percent: 2 });
    await recordQuota(env, quota(14, 3000));
    await settleQuota(env, now + DAY);
    expect(await used()).toEqual({ used_percent: 2 });
});
