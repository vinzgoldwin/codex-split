import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { sha256 } from '../worker/crypto';
import { DAY } from '../worker/batches';
import { recordQuota } from '../worker/index';
import type { DashboardData } from '../src/types';

it('keeps member estimates independent of account movements, other members, delayed uploads and retries', async () => {
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
    expect(before).toMatchObject({ used: 0.62, estimateIncomplete: false });
    expect(before.shareUsed).toBeCloseTo((0.62 / before.allocation) * 100);
    expect((await dashboard()).account).toMatchObject({ used: 44, unattributed: 43.38, estimateExcess: 0 });

    // Account quota can move with no uploaded activity. It must not manufacture member usage.
    await send(tokens[0], { sequence: 2, usage: [], quota: quota(87, now + 1000) });
    let data = await dashboard();
    expect(data.account).toMatchObject({ used: 87, unattributed: 86.38, estimateExcess: 0 });
    expect(data.members.find((member) => member.id === 1)).toMatchObject({
        weeklyTokens: before.weeklyTokens,
        weeklyCost: before.weeklyCost,
        todayTokens: before.todayTokens,
        used: before.used,
        shareUsed: before.shareUsed,
    });

    // An unknown model on another member must not switch or rescale anyone else's totals.
    await send(tokens[1], { sequence: 1, usage: [{ ...usage, model: 'unknown-model' }], quota: quota(88, now + 2000) });
    data = await dashboard();
    expect(data.members.find((member) => member.id === 1)?.weeklyTokens).toBe(1200);
    expect(data.members.find((member) => member.id === 2)?.weeklyTokens).toBe(1200);
    expect(data.account).toMatchObject({ used: 88, unattributed: 87.38 });
    expect(data.members.find((member) => member.id === 1)?.used).toBe(0.62);
    expect(data.members.find((member) => member.id === 2)).toMatchObject({ used: 0, estimateIncomplete: true });

    const delayed = { sequence: 3, batch_id: crypto.randomUUID(), usage: [usage] };
    await send(tokens[0], delayed);
    await send(tokens[0], delayed);
    await send(tokens[2], { sequence: 1, usage: [usage] });
    await send(tokens[0], { sequence: 4, usage: [], quota: quota(10, now - 1000) });
    data = await dashboard();
    expect(data.account?.used).toBe(88);
    expect(data.members.find((member) => member.id === 1)).toMatchObject({ used: 1.86, weeklyTokens: 3600, todayTokens: 0, thirtyDayTokens: 3600 });
    expect(data.members.find((member) => member.id === 2)?.weeklyTokens).toBe(1200);

    // The retired allocation column must never affect the new estimate.
    await env.DB.prepare('UPDATE quota_window_members SET used_percent = 20 WHERE member_id = 1').run();
    data = await dashboard();
    expect(data.account).toMatchObject({ used: 88, unattributed: 86.14 });
    expect(data.members.find((member) => member.id === 1)).toMatchObject({ used: 1.86, weeklyTokens: 3600 });

    // Another member's Fast activity increases only their estimate, with the fixed tier multiplier.
    await send(tokens[1], { sequence: 2, usage: [{ ...usage, service_tier: 'priority' }], quota: quota(89, now + 3000) });
    data = await dashboard();
    expect(data.members.find((member) => member.id === 1)?.used).toBe(1.86);
    expect(data.members.find((member) => member.id === 2)?.used).toBe(1.55);

    // Quota corrections or estimation error must not cap or redistribute member estimates.
    await send(tokens[0], { sequence: 5, usage: [], quota: quota(1, now + 4000) });
    data = await dashboard();
    expect(data.account).toMatchObject({ used: 1, unattributed: 0 });
    expect(data.account?.estimateExcess).toBeCloseTo(2.41);
    expect(data.members.find((member) => member.id === 1)?.used).toBe(1.86);
    expect(data.members.find((member) => member.id === 2)?.used).toBe(1.55);

    await recordQuota(env, { ...quota(3, now + 2 * DAY), resets_at: new Date(now + 9 * DAY).toISOString() });
    data = await dashboard();
    expect(data.account).toMatchObject({ used: 3, unattributed: 3, estimateExcess: 0 });
    expect(data.members.every((member) => member.used === 0 && member.weeklyTokens === 0)).toBe(true);
});
