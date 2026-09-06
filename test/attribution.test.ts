import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { sha256 } from '../worker/crypto';
import { settleQuota } from '../worker/attribution';
import { recordQuota } from '../worker/index';
import { DAY } from '../worker/batches';
import type { DashboardData } from '../src/types';

it('freezes interval percentages and never charges an idle member for someone else’s activity', async () => {
    const now = Date.now();
    const tokens = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, token] of tokens.entries()) {
        await env.DB.prepare('INSERT INTO devices (id, member_id, token_hash, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), index + 1, await sha256(token), `interval-${index}`, 'linux', now)
            .run();
    }
    const login = await SELF.fetch('https://split.test/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 1, password: 'Akashi' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const dashboard = async () => {
        const result = await SELF.fetch('https://split.test/api/dashboard', { headers: { Cookie: cookie } });
        expect(result.status).toBe(200);
        return (await result.json()) as DashboardData;
    };
    const quota = (used: number, offset: number) => ({
        used_percent: used,
        window_duration_mins: 10080,
        resets_at: new Date(now + 2 * DAY).toISOString(),
        sampled_at: new Date(now + offset).toISOString(),
    });
    const usage = (offset: number, model = 'gpt-5.6-sol') => ({
        model,
        input_tokens: 1000,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 100,
        reasoning_output_tokens: 0,
        service_tier: 'default',
        recorded_at: new Date(now + offset).toISOString(),
    });
    const send = async (member: number, body: object) => {
        const result = await SELF.fetch('https://split.test/api/sync', {
            method: 'POST',
            headers: { Authorization: `Bearer ${tokens[member - 1]}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ protocol: 2, batch_id: crypto.randomUUID(), agent_version: '0.2.0', ...body }),
        });
        expect(result.status).toBe(200);
    };
    const settle = () => settleQuota(env, now + DAY);
    const percentages = async () =>
        (await dashboard()).members
            .filter((m) => m.id <= 2)
            .sort((a, b) => a.id - b.id)
            .map((m) => m.used);

    await send(1, { sequence: 1, usage: [usage(-DAY)], quota: quota(10, 0) });
    await send(1, { sequence: 2, usage: [usage(1000)], quota: quota(10, 1500) });
    await send(2, { sequence: 1, usage: [usage(2000)], quota: quota(12, 3000) });
    // Don't assign the increase to whichever collector uploads first. Wait for both.
    expect(await percentages()).toEqual([0, 0]);
    await Promise.all([settle(), settle()]);
    expect(await percentages()).toEqual([1, 1]);

    await send(1, { sequence: 3, usage: [], quota: quota(16, 6000) });
    // This report arrives after the quota was observed, but before the interval settles.
    const darius = { sequence: 2, batch_id: crypto.randomUUID(), usage: [usage(5000)], quota: quota(16, 6000) };
    await send(2, darius);
    await send(2, darius);
    await settle();
    expect(await percentages()).toEqual([1, 5]);

    await send(2, { sequence: 3, usage: [usage(7000, 'unknown-model')], quota: quota(18, 8000) });
    await settle();
    expect(await percentages()).toEqual([1, 7]);
    await send(1, { sequence: 4, usage: [], quota: quota(20, 10000) });
    await settle();
    expect(await percentages()).toEqual([1, 7]);
    expect((await dashboard()).account?.unattributed).toBe(12);

    // A report too late for a finalized interval updates tokens, never an unrelated interval.
    await send(1, { sequence: 5, usage: [usage(9000)] });
    await settle();
    expect(await percentages()).toEqual([1, 7]);
    await send(1, { sequence: 6, usage: [usage(11000)], quota: quota(21, 12000) });
    await settle();
    expect(await percentages()).toEqual([2, 7]);

    // Stale samples and quota corrections must not allocate the same increase twice.
    await recordQuota(env, quota(15, 11000));
    await recordQuota(env, quota(19, 13000));
    await recordQuota(env, quota(21, 14000));
    await send(2, { sequence: 4, usage: [usage(14500)], quota: quota(22, 15000) });
    await settle();
    expect(await percentages()).toEqual([2, 8]);

    const reset = { ...quota(3, 2 * DAY + 1000), resets_at: new Date(now + 9 * DAY).toISOString() };
    await recordQuota(env, reset);
    expect(await percentages()).toEqual([0, 0]);
    expect((await dashboard()).account?.unattributed).toBe(3);
});
