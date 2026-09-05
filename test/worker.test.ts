import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

async function request(path: string, init?: RequestInit) {
    return SELF.fetch(`https://split.test${path}`, init);
}

async function login(memberId = 1) {
    const result = await request('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, password: 'Akashi' }),
    });
    expect(result.status).toBe(200);
    return result.headers.get('Set-Cookie')?.split(';')[0] || '';
}

describe('Codex Split Worker', () => {
    it('rejects an incorrect tracker password', async () => {
        const result = await request('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberId: 1, password: 'wrong' }),
        });

        expect(result.status).toBe(422);
    });

    it('pairs a device once and attributes its quota movement', async () => {
        const pairing = await request('/api/pairings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'kego-mac',
                platform: 'macos',
                arch: 'arm64',
                agent_version: '0.1.0',
                account_email: 'shared-account@example.com',
            }),
        });
        expect(pairing.status).toBe(201);
        const { code, secret } = (await pairing.json()) as { code: string; secret: string };
        const cookie = await login();

        const claim = await request(`/api/pairings/${code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ memberId: 1 }),
        });
        expect(claim.status).toBe(200);

        const status = await request(`/api/pairings/${code}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret }),
        });
        expect(status.status).toBe(200);
        const device = (await status.json()) as { token: string };

        const secondDelivery = await request(`/api/pairings/${code}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret }),
        });
        expect(secondDelivery.status).toBe(410);

        const now = new Date();
        const reset = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);
        const firstBatchId = crypto.randomUUID();
        const firstSyncBody = JSON.stringify({
            batch_id: firstBatchId,
            reported_at: now.toISOString(),
            agent_version: '0.1.0',
            usage: [{ model: 'gpt-5.6-sol', input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 }],
            quota: {
                used_percent: 45,
                window_duration_mins: 10_080,
                resets_at: reset.toISOString(),
                sampled_at: now.toISOString(),
            },
        });
        const sync = await request('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${device.token}` },
            body: firstSyncBody,
        });
        expect(sync.status).toBe(200);
        const duplicate = await request('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${device.token}` },
            body: firstSyncBody,
        });
        expect(duplicate.status).toBe(200);

        const newerSample = new Date(now.getTime() + 60_000);
        const nearbyReset = new Date(reset.getTime() - 2_000);
        const nearbySync = await request('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${device.token}` },
            body: JSON.stringify({
                batch_id: crypto.randomUUID(),
                reported_at: newerSample.toISOString(),
                agent_version: '0.1.0',
                usage: [],
                quota: {
                    used_percent: 46,
                    window_duration_mins: 10_080,
                    resets_at: nearbyReset.toISOString(),
                    sampled_at: newerSample.toISOString(),
                },
            }),
        });
        expect(nearbySync.status).toBe(200);

        const dashboard = await request('/api/dashboard', { headers: { Cookie: cookie } });
        expect(dashboard.status).toBe(200);
        const data = (await dashboard.json()) as {
            account: { used: number; unattributed: number };
            members: Array<{
                id: number;
                allocation: number;
                used: number;
                shareUsed: number;
                weeklyCost: number;
                todayCost: number;
                todayTokens: number;
                thirtyDayCost: number;
                thirtyDayTokens: number;
                devices: unknown[];
            }>;
        };
        const kevin = data.members.find((member) => member.id === 1);
        const darius = data.members.find((member) => member.id === 2);

        expect(data.account.used).toBe(46);
        expect(data.account.unattributed).toBe(45);
        expect(kevin).toMatchObject({ allocation: 33.333, used: 1 });
        expect(kevin?.shareUsed).toBeCloseTo(3, 1);
        expect(kevin?.devices).toHaveLength(1);
        expect(darius).toMatchObject({ allocation: 33.333, used: 0, shareUsed: 0 });
        const rawCost = await env.DB.prepare('SELECT SUM(estimated_cost_micros) AS cost FROM usage_entries').first<{ cost: number }>();
        const rawTokens = await env.DB.prepare('SELECT SUM(input_tokens + output_tokens) AS tokens FROM usage_entries').first<{ tokens: number }>();
        const dailyCost = await env.DB.prepare('SELECT SUM(estimated_cost_micros) AS cost FROM member_usage_days').first<{ cost: number }>();
        expect(dailyCost?.cost).toBe(rawCost?.cost);
        expect(kevin).toMatchObject({
            weeklyCost: (rawCost?.cost || 0) / 1_000_000,
            todayCost: (rawCost?.cost || 0) / 1_000_000,
            todayTokens: rawTokens?.tokens,
            thirtyDayCost: (rawCost?.cost || 0) / 1_000_000,
            thirtyDayTokens: rawTokens?.tokens,
        });

        const secondPairing = await request('/api/pairings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'akashi-linux',
                platform: 'linux',
                arch: 'x64',
                agent_version: '0.1.0',
                account_email: 'shared-account@example.com',
            }),
        });
        const secondPairingData = (await secondPairing.json()) as { code: string; secret: string };
        await request(`/api/pairings/${secondPairingData.code}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ memberId: 2 }),
        });
        const secondStatus = await request(`/api/pairings/${secondPairingData.code}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: secondPairingData.secret }),
        });
        const secondDevice = (await secondStatus.json()) as { token: string };
        await request('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secondDevice.token}` },
            body: JSON.stringify({
                batch_id: crypto.randomUUID(),
                reported_at: now.toISOString(),
                agent_version: '0.1.0',
                usage: [{ model: 'gpt-5.6-sol', input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 }],
            }),
        });

        const balanced = await request('/api/dashboard', { headers: { Cookie: cookie } });
        const balancedMembers = ((await balanced.json()) as { members: Array<{ id: number; used: number }> }).members;
        expect(balancedMembers.find((member) => member.id === 1)?.used).toBe(0.5);
        expect(balancedMembers.find((member) => member.id === 2)?.used).toBe(0.5);
    });

    it('rejects a device using the wrong ChatGPT account', async () => {
        const result = await request('/api/pairings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'wrong-account',
                platform: 'windows',
                arch: 'amd64',
                agent_version: '0.1.0',
                account_email: 'someone@example.com',
            }),
        });

        expect(result.status).toBe(422);
        await expect(result.json()).resolves.toEqual({ message: 'Codex is logged in to a different ChatGPT account.' });
    });
});
