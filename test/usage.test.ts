import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { sha256 } from '../worker/crypto';
import { DAY } from '../worker/batches';
import type { DashboardData } from '../src/types';

it('counts only each member’s recorded tokens across quota changes, other members, delayed uploads and retries', async () => {
    const now = Date.now();
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
    expect((await dashboard()).members.find((member) => member.id === 1)?.weeklyTokens).toBeNull();

    const tokens = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, token] of tokens.entries()) {
        await env.DB.prepare('INSERT INTO devices (id, member_id, token_hash, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), index === 1 ? 2 : 1, await sha256(token), `usage-test-${index}`, 'linux', now)
            .run();
    }
    const quota = (used: number, sampledAt = now) => ({
        used_percent: used,
        window_duration_mins: 10_080,
        resets_at: new Date(now + 2 * DAY).toISOString(),
        sampled_at: new Date(sampledAt).toISOString(),
    });
    const usage = {
        model: 'gpt-5.6-sol',
        input_tokens: 1000,
        cached_input_tokens: 500,
        cache_write_input_tokens: 0,
        output_tokens: 200,
        reasoning_output_tokens: 100,
        recorded_at: new Date(now - DAY).toISOString(),
        service_tier: 'default',
    };
    const send = async (token: string, payload: object) => {
        const result = await SELF.fetch('https://split.test/api/sync', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ protocol: 2, batch_id: crypto.randomUUID(), agent_version: '0.2.0', ...payload }),
        });
        expect(result.status).toBe(200);
    };
    await send(tokens[0], { sequence: 1, usage: [usage], quota: quota(44) });
    const before = (await dashboard()).members.find((member) => member.id === 1)!;
    expect(before).toMatchObject({ weeklyTokens: 1200, todayTokens: 0, thirtyDayTokens: 1200 });
    expect(before).toMatchObject({ used: 0, shareUsed: 0 });

    // Account quota can move with no uploaded activity. It must not manufacture member usage.
    await send(tokens[0], { sequence: 2, usage: [], quota: quota(87, now + 1000) });
    let data = await dashboard();
    expect(data.account?.used).toBe(87);
    expect(data.members.find((member) => member.id === 1)).toMatchObject({
        weeklyTokens: before.weeklyTokens,
        weeklyCost: before.weeklyCost,
        todayTokens: before.todayTokens,
    });

    // An unknown model on another member must not switch or rescale anyone else's totals.
    await send(tokens[1], { sequence: 1, usage: [{ ...usage, model: 'unknown-model' }], quota: quota(88, now + 2000) });
    data = await dashboard();
    expect(data.members.find((member) => member.id === 1)?.weeklyTokens).toBe(1200);
    expect(data.members.find((member) => member.id === 2)?.weeklyTokens).toBe(1200);

    const delayed = { sequence: 3, batch_id: crypto.randomUUID(), usage: [usage] };
    await send(tokens[0], delayed);
    await send(tokens[0], delayed);
    await send(tokens[2], { sequence: 1, usage: [usage] });
    await send(tokens[0], { sequence: 4, usage: [], quota: quota(10, now - 1000) });
    data = await dashboard();
    expect(data.account?.used).toBe(88);
    expect(data.members.find((member) => member.id === 1)).toMatchObject({ weeklyTokens: 3600, todayTokens: 0, thirtyDayTokens: 3600 });
    expect(data.members.find((member) => member.id === 2)?.weeklyTokens).toBe(1200);
});
