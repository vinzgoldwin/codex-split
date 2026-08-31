import { SELF } from 'cloudflare:test';
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
        const sync = await request('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${device.token}` },
            body: JSON.stringify({
                batch_id: crypto.randomUUID(),
                reported_at: now.toISOString(),
                agent_version: '0.1.0',
                usage: [{ model: 'gpt-5.6-sol', input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 }],
                quota: {
                    used_percent: 45,
                    window_duration_mins: 10_080,
                    resets_at: reset.toISOString(),
                    sampled_at: now.toISOString(),
                },
            }),
        });
        expect(sync.status).toBe(200);

        const dashboard = await request('/api/dashboard', { headers: { Cookie: cookie } });
        expect(dashboard.status).toBe(200);
        const data = (await dashboard.json()) as {
            account: { used: number };
            members: Array<{ id: number; allocation: number; used: number; shareUsed: number; devices: unknown[] }>;
        };
        const kevin = data.members.find((member) => member.id === 1);
        const darius = data.members.find((member) => member.id === 2);

        expect(data.account.used).toBe(45);
        expect(kevin).toMatchObject({ allocation: 33.333, used: 45 });
        expect(kevin?.shareUsed).toBeCloseTo(135, 1);
        expect(kevin?.devices).toHaveLength(1);
        expect(darius).toMatchObject({ allocation: 33.333, used: 0, shareUsed: 0 });

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
        expect(balancedMembers.find((member) => member.id === 1)?.used).toBe(22.5);
        expect(balancedMembers.find((member) => member.id === 2)?.used).toBe(22.5);
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
