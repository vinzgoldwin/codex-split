import { decrypt, encrypt, expiredSessionCookie, randomToken, secretMatches, sessionCookie, sessionMemberId, sha256 } from './crypto';
import { estimateMicros, PRICING_VERSION } from './pricing';
import { contributions, summaryStatements, repriceBatch, DAY } from './batches';
import type { DeviceRow, Env, MemberRow, QuotaInput, QuotaWindowRow, RequestUsage, UsageInput } from './types';

class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

interface PairingRow {
    code: string;
    secret_hash: string;
    device_name: string;
    platform: string;
    arch: string | null;
    agent_version: string | null;
    device_id: string | null;
    device_token_cipher: string | null;
    expires_at: number;
    claimed_at: number | null;
    delivered_at: number | null;
}

interface MemberWindowUsageRow {
    member_id: number;
    cost: number;
    weight: number;
    tokens: number;
    incomplete_entries: number;
}

interface MemberPeriodUsageRow {
    member_id: number;
    today_cost: number;
    today_tokens: number;
    thirty_day_cost: number;
    thirty_day_tokens: number;
    incomplete_entries: number;
}

const QUOTA_RESET_TOLERANCE_MS = 5 * 60 * 1000;

function response(data: unknown, status = 200, headers?: HeadersInit): Response {
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Cache-Control', 'no-store');

    return Response.json(data, {
        status,
        headers: responseHeaders,
    });
}

async function body(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (text.length > 1_000_000) throw new ApiError(413, 'Request is too large.');

    try {
        const value: unknown = JSON.parse(text || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value as Record<string, unknown>;
    } catch {
        throw new ApiError(422, 'Invalid JSON request.');
    }
}

function textField(value: unknown, name: string, maxLength: number, optional = false): string | null {
    if (optional && (value === null || value === undefined || value === '')) return null;
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new ApiError(422, `${name} is invalid.`);
    return value.trim();
}

function numberField(value: unknown, name: string, min: number, max: number, integer = false): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new ApiError(422, `${name} is invalid.`);
    }
    return value;
}

function timestamp(value: unknown, name: string): number {
    if (typeof value !== 'string') throw new ApiError(422, `${name} is invalid.`);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new ApiError(422, `${name} is invalid.`);
    return parsed;
}

async function viewer(request: Request, env: Env): Promise<MemberRow> {
    const memberId = await sessionMemberId(request, env.AUTH_SECRET);
    if (!memberId) throw new ApiError(401, 'Log in to continue.');

    const member = await env.DB.prepare('SELECT id, name, active FROM members WHERE id = ? AND active = 1').bind(memberId).first<MemberRow>();
    if (!member) throw new ApiError(401, 'Your session is no longer active.');
    return member;
}

async function device(request: Request, env: Env): Promise<DeviceRow> {
    const authorization = request.headers.get('Authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) throw new ApiError(401, 'Invalid or revoked device token.');

    const row = await env.DB.prepare(
        `SELECT d.id, d.member_id, d.name, d.platform, d.last_seen_at
         FROM devices d
         JOIN members m ON m.id = d.member_id
         WHERE d.token_hash = ? AND d.revoked_at IS NULL AND m.active = 1`,
    )
        .bind(await sha256(token))
        .first<DeviceRow>();
    if (!row) throw new ApiError(401, 'Invalid or revoked device token.');
    return row;
}

async function loginOptions(env: Env): Promise<Response> {
    const result = await env.DB.prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY name').all<Pick<MemberRow, 'id' | 'name'>>();
    return response({ members: result.results });
}

async function login(request: Request, env: Env): Promise<Response> {
    const data = await body(request);
    const memberId = numberField(data.memberId, 'memberId', 1, Number.MAX_SAFE_INTEGER, true);
    const password = textField(data.password, 'password', 500) as string;
    const member = await env.DB.prepare('SELECT id, name, active FROM members WHERE id = ? AND active = 1').bind(memberId).first<MemberRow>();

    if (!member || !(await secretMatches(password, env.TRACKER_PASSWORD, env.AUTH_SECRET))) {
        throw new ApiError(422, 'That tracker password is incorrect.');
    }

    return response({ viewer: { id: member.id, name: member.name } }, 200, { 'Set-Cookie': await sessionCookie(member.id, env.AUTH_SECRET) });
}

async function dashboard(request: Request, env: Env): Promise<Response> {
    const currentViewer = await viewer(request, env);
    const weightPerPercent = Number(env.QUOTA_WEIGHT_PER_PERCENT);
    if (!Number.isFinite(weightPerPercent) || weightPerPercent <= 0) throw new Error('QUOTA_WEIGHT_PER_PERCENT must be a positive number.');
    const window = await env.DB.prepare('SELECT * FROM quota_windows ORDER BY sampled_at DESC LIMIT 1').first<QuotaWindowRow>();
    const activeMembers = await env.DB.prepare('SELECT id, name, active FROM members WHERE active = 1 ORDER BY name').all<MemberRow>();
    const activeShare = activeMembers.results.length ? Math.round((100 / activeMembers.results.length) * 1000) / 1000 : 0;

    const windowMembers = window
        ? await env.DB.prepare(
              `SELECT m.id, m.name, m.active
               FROM quota_window_members qwm
               JOIN members m ON m.id = qwm.member_id
               WHERE qwm.quota_window_id = ?
               ORDER BY m.name`,
          )
              .bind(window.id)
              .all<MemberRow>()
        : { results: [] as MemberRow[] };

    const devices = await env.DB.prepare(
        `SELECT id, member_id, name, platform, agent_version, last_seen_at
         FROM devices WHERE revoked_at IS NULL ORDER BY name`,
    ).all<DeviceRow>();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const todayStart = Math.floor(now / dayMs) * dayMs;
    const thirtyDayStart = todayStart - 29 * dayMs;
    const periodUsage = await env.DB.prepare(
        `SELECT member_id,
                SUM(CASE WHEN day_start = ? THEN estimated_cost_micros ELSE 0 END) AS today_cost,
                SUM(CASE WHEN day_start = ? THEN input_tokens + output_tokens ELSE 0 END) AS today_tokens,
                SUM(estimated_cost_micros) AS thirty_day_cost,
                SUM(input_tokens + output_tokens) AS thirty_day_tokens, SUM(incomplete_entries) AS incomplete_entries
         FROM member_usage_days
         WHERE day_start >= ?
         GROUP BY member_id`,
    )
        .bind(todayStart, todayStart, thirtyDayStart)
        .all<MemberPeriodUsageRow>();
    const windowUsage = window
        ? await env.DB.prepare(
              `SELECT member_id,
                      estimated_cost_micros AS cost,
                      usage_weight AS weight,
                      input_tokens + output_tokens AS tokens,
                      incomplete_entries
               FROM quota_window_members
               WHERE quota_window_id = ?`,
          )
              .bind(window.id)
              .all<MemberWindowUsageRow>()
        : { results: [] as MemberWindowUsageRow[] };

    const byId = new Map<number, MemberRow>();
    for (const member of windowMembers.results) byId.set(member.id, member);
    for (const member of activeMembers.results) {
        if (!byId.has(member.id)) byId.set(member.id, member);
    }

    const periodUsageByMember = new Map(periodUsage.results.map((row) => [row.member_id, row]));
    const windowUsageByMember = new Map(windowUsage.results.map((row) => [row.member_id, row]));
    const devicesByMember = new Map<number, DeviceRow[]>();
    for (const row of devices.results) {
        const memberDevices = devicesByMember.get(row.member_id) || [];
        memberDevices.push(row);
        devicesByMember.set(row.member_id, memberDevices);
    }
    const members = [...byId.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((member) => {
            const periods = periodUsageByMember.get(member.id);
            const weekly = windowUsageByMember.get(member.id);
            const allocation = member.active === 1 ? activeShare : 0;
            // Fixed calibration: account movements and other members never rescale this estimate.
            const used = (weekly?.weight || 0) / weightPerPercent;

            return {
                id: member.id,
                name: member.name,
                active: member.active === 1,
                allocation,
                used,
                shareUsed: allocation > 0 ? (used / allocation) * 100 : 0,
                estimateIncomplete: (weekly?.incomplete_entries || 0) > 0,
                pricingIncomplete: (periods?.incomplete_entries || 0) > 0 || (windowUsageByMember.get(member.id)?.incomplete_entries || 0) > 0,
                weeklyCost: (weekly?.cost || 0) / 1_000_000,
                weeklyTokens: window ? weekly?.tokens || 0 : null,
                todayCost: (periods?.today_cost || 0) / 1_000_000,
                todayTokens: periods?.today_tokens || 0,
                thirtyDayCost: (periods?.thirty_day_cost || 0) / 1_000_000,
                thirtyDayTokens: periods?.thirty_day_tokens || 0,
                devices: (devicesByMember.get(member.id) || []).map((row) => ({
                    id: row.id,
                    name: row.name,
                    platform: row.platform,
                    agentVersion: row.agent_version,
                    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
                    online: row.last_seen_at
                        ? row.last_seen_at >
                          now - (Math.max(syncSettings(env).sync_interval_seconds, syncSettings(env).idle_interval_seconds) + 120) * 1000
                        : false,
                })),
            };
        });

    const estimatedTotal = members.reduce((sum, member) => sum + member.used, 0);
    return response({
        viewer: { id: currentViewer.id, name: currentViewer.name },
        account: window
            ? {
                  used: window.used_percent,
                  resetsAt: new Date(window.reset_at).toISOString(),
                  sampledAt: new Date(window.sampled_at).toISOString(),
                  unattributed: Math.max(0, window.used_percent - estimatedTotal),
                  estimateExcess: Math.max(0, estimatedTotal - window.used_percent),
              }
            : null,
        members,
        warningPercent: Number(env.TRACKER_WARNING_PERCENT || 90),
    });
}

async function addMember(request: Request, env: Env): Promise<Response> {
    await viewer(request, env);
    const data = await body(request);
    const name = textField(data.name, 'name', 80) as string;
    const now = Date.now();

    try {
        const member = await env.DB.prepare('INSERT INTO members (name, active, created_at, updated_at) VALUES (?, 1, ?, ?) RETURNING id, name')
            .bind(name, now, now)
            .first<{ id: number; name: string }>();
        return response({ member, message: 'Member added. The weekly split has been updated.' }, 201);
    } catch (error) {
        if (String(error).includes('UNIQUE')) throw new ApiError(409, 'A member with that name already exists.');
        throw error;
    }
}

async function deactivateMember(request: Request, env: Env, memberId: number): Promise<Response> {
    const currentViewer = await viewer(request, env);
    if (currentViewer.id === memberId) throw new ApiError(422, 'You cannot deactivate your own profile.');
    const active = await env.DB.prepare('SELECT COUNT(*) AS count FROM members WHERE active = 1').first<{ count: number }>();
    if ((active?.count || 0) <= 1) throw new ApiError(422, 'At least one active member is required.');

    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('UPDATE members SET active = 0, deactivated_at = ?, updated_at = ? WHERE id = ? AND active = 1').bind(now, now, memberId),
        env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').bind(now, memberId),
    ]);
    return response({ message: 'Member deactivated. The weekly split has been updated.' });
}

async function revokeDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
    await viewer(request, env);
    await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(Date.now(), deviceId).run();
    return response({ message: 'Device access revoked.' });
}

function pairingCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const code = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function createPairing(request: Request, env: Env): Promise<Response> {
    const data = await body(request);
    const name = textField(data.name, 'name', 120) as string;
    const platform = textField(data.platform, 'platform', 40) as string;
    const arch = textField(data.arch, 'arch', 40, true);
    const agentVersion = textField(data.agent_version, 'agent_version', 40, true);
    const accountEmail = textField(data.account_email, 'account_email', 320) as string;
    if (accountEmail.toLowerCase() !== env.CHATGPT_ACCOUNT_EMAIL.toLowerCase()) {
        throw new ApiError(422, 'Codex is logged in to a different ChatGPT account.');
    }
    const secret = randomToken(36);
    const now = Date.now();
    let code = pairingCode();

    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            await env.DB.prepare(
                `INSERT INTO pairings
                 (code, secret_hash, device_name, platform, arch, agent_version, expires_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
                .bind(code, await sha256(secret), name, platform, arch, agentVersion, now + 10 * 60 * 1000, now)
                .run();
            return response(
                {
                    code,
                    secret,
                    verification_url: `${new URL(request.url).origin}/pair/${code}`,
                    expires_in: 600,
                },
                201,
            );
        } catch (error) {
            if (!String(error).includes('UNIQUE')) throw error;
            code = pairingCode();
        }
    }
    throw new ApiError(503, 'Could not create a pairing code.');
}

async function pairingDetails(request: Request, env: Env, code: string): Promise<Response> {
    const currentViewer = await viewer(request, env);
    const pairing = await env.DB.prepare(
        `SELECT code, device_name, platform, arch FROM pairings
         WHERE code = ? AND claimed_at IS NULL AND expires_at > ?`,
    )
        .bind(code, Date.now())
        .first<Pick<PairingRow, 'code' | 'device_name' | 'platform' | 'arch'>>();
    if (!pairing) throw new ApiError(404, 'This pairing code is invalid or expired.');

    const members = await env.DB.prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY name').all<Pick<MemberRow, 'id' | 'name'>>();
    return response({
        pairing: { code: pairing.code, name: pairing.device_name, platform: pairing.platform, arch: pairing.arch },
        members: members.results,
        currentMemberId: currentViewer.id,
    });
}

async function claimPairing(request: Request, env: Env, code: string): Promise<Response> {
    await viewer(request, env);
    const data = await body(request);
    const memberId = numberField(data.memberId, 'memberId', 1, Number.MAX_SAFE_INTEGER, true);
    const member = await env.DB.prepare('SELECT id FROM members WHERE id = ? AND active = 1').bind(memberId).first<{ id: number }>();
    if (!member) throw new ApiError(422, 'Choose an active member.');

    const pairing = await env.DB.prepare('SELECT * FROM pairings WHERE code = ? AND claimed_at IS NULL AND expires_at > ?')
        .bind(code, Date.now())
        .first<PairingRow>();
    if (!pairing) throw new ApiError(404, 'This pairing code is invalid or expired.');

    const deviceId = crypto.randomUUID();
    const token = randomToken(48);
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO devices
             (id, member_id, token_hash, name, platform, arch, agent_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(deviceId, memberId, await sha256(token), pairing.device_name, pairing.platform, pairing.arch, pairing.agent_version, now),
        env.DB.prepare(
            `UPDATE pairings SET device_id = ?, device_token_cipher = ?, claimed_at = ?
             WHERE code = ? AND claimed_at IS NULL`,
        ).bind(deviceId, await encrypt(token, env.AUTH_SECRET), now, code),
    ]);
    return response({ message: 'Device connected.' });
}

async function pairingStatus(request: Request, env: Env, code: string): Promise<Response> {
    const data = await body(request);
    const secret = textField(data.secret, 'secret', 200) as string;
    const pairing = await env.DB.prepare('SELECT * FROM pairings WHERE code = ?').bind(code).first<PairingRow>();
    if (!pairing || !(await secretMatches(await sha256(secret), pairing.secret_hash, env.AUTH_SECRET))) {
        throw new ApiError(404, 'Pairing not found.');
    }
    if (pairing.expires_at < Date.now() && !pairing.claimed_at) throw new ApiError(410, 'Pairing expired.');
    if (!pairing.claimed_at) return response({ status: 'pending' });
    if (pairing.delivered_at || !pairing.device_id || !pairing.device_token_cipher) throw new ApiError(410, 'Pairing already delivered.');

    const token = await decrypt(pairing.device_token_cipher, env.AUTH_SECRET);
    await env.DB.prepare('UPDATE pairings SET delivered_at = ? WHERE code = ? AND delivered_at IS NULL').bind(Date.now(), code).run();
    return response({ status: 'claimed', device_id: pairing.device_id, token });
}

function usageInput(value: unknown): UsageInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'usage is invalid.');
    const row = value as Record<string, unknown>;
    return {
        model: textField(row.model, 'model', 80) as string,
        input_tokens: numberField(row.input_tokens, 'input_tokens', 0, 1_000_000_000, true),
        cached_input_tokens: numberField(row.cached_input_tokens, 'cached_input_tokens', 0, 1_000_000_000, true),
        output_tokens: numberField(row.output_tokens, 'output_tokens', 0, 1_000_000_000, true),
    };
}

function quotaInput(value: unknown): QuotaInput | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'quota is invalid.');
    const row = value as Record<string, unknown>;
    return {
        used_percent: numberField(row.used_percent, 'used_percent', 0, 100),
        window_duration_mins: numberField(row.window_duration_mins, 'window_duration_mins', 1, 20_160, true),
        resets_at: new Date(timestamp(row.resets_at, 'resets_at')).toISOString(),
        sampled_at: new Date(timestamp(row.sampled_at, 'sampled_at')).toISOString(),
    };
}

async function recordQuota(env: Env, quota: QuotaInput): Promise<QuotaWindowRow> {
    const resetAt = Date.parse(quota.resets_at);
    const sampledAt = Date.parse(quota.sampled_at);
    let window = await env.DB.prepare(
        `SELECT * FROM quota_windows
         WHERE duration_minutes = ? AND reset_at BETWEEN ? AND ?
         ORDER BY sampled_at DESC LIMIT 1`,
    )
        .bind(quota.window_duration_mins, resetAt - QUOTA_RESET_TOLERANCE_MS, resetAt + QUOTA_RESET_TOLERANCE_MS)
        .first<QuotaWindowRow>();

    if (!window) {
        const inserted = await env.DB.prepare(
            `INSERT OR IGNORE INTO quota_windows
             (reset_at, duration_minutes, used_percent, baseline_used_percent, sampled_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        )
            .bind(resetAt, quota.window_duration_mins, quota.used_percent, quota.used_percent, sampledAt, Date.now())
            .first<QuotaWindowRow>();
        window = inserted || (await env.DB.prepare('SELECT * FROM quota_windows WHERE reset_at = ?').bind(resetAt).first<QuotaWindowRow>());
        if (!window) throw new Error('Could not create quota window.');

        if (inserted) {
            const members = await env.DB.prepare('SELECT id FROM members WHERE active = 1 ORDER BY id').all<{ id: number }>();
            const share = members.results.length ? Math.round((100 / members.results.length) * 1000) / 1000 : 0;
            if (members.results.length) {
                await env.DB.batch(
                    members.results.map((member) =>
                        env.DB.prepare('INSERT INTO quota_window_members (quota_window_id, member_id, allocation_percent) VALUES (?, ?, ?)').bind(
                            window!.id,
                            member.id,
                            share,
                        ),
                    ),
                );
            }
        }
    }

    await env.DB.prepare(
        `UPDATE quota_windows SET duration_minutes = ?, used_percent = ?, sampled_at = ?
         WHERE id = ? AND sampled_at <= ?`,
    )
        .bind(quota.window_duration_mins, quota.used_percent, sampledAt, window.id, sampledAt)
        .run();

    return window;
}

function syncSettings(env: Env) {
    const seconds = (value: string | undefined, fallback: number) => Math.max(60, Math.min(3600, Math.round(Number(value)) || fallback));
    return {
        ok: true,
        sync_interval_seconds: seconds(env.SYNC_INTERVAL_SECONDS, 300),
        idle_interval_seconds: seconds(env.IDLE_INTERVAL_SECONDS, 900),
    };
}

async function syncRequests(env: Env, currentDevice: DeviceRow, data: Record<string, unknown>): Promise<Response> {
    const sequence = numberField(data.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER, true);
    const batchId = textField(data.batch_id, 'batch_id', 64) as string;
    const version = textField(data.agent_version, 'agent_version', 40) as string;
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new ApiError(422, 'batch_id is invalid.');
    if (!Array.isArray(data.usage) || data.usage.length > 128) throw new ApiError(422, 'usage must contain at most 128 requests.');
    const now = Date.now();
    const usages: RequestUsage[] = data.usage.map((value) => {
        const base = usageInput(value);
        const row = value as Record<string, unknown>;
        const cacheWrite = numberField(row.cache_write_input_tokens ?? 0, 'cache_write_input_tokens', 0, 1_000_000_000, true);
        const reasoning = numberField(row.reasoning_output_tokens ?? 0, 'reasoning_output_tokens', 0, 1_000_000_000, true);
        const at = timestamp(row.recorded_at, 'recorded_at');
        if (at > now + 5 * 60_000) throw new ApiError(422, 'Usage timestamp is in the future.');
        if (base.cached_input_tokens + cacheWrite > base.input_tokens || reasoning > base.output_tokens)
            throw new ApiError(422, 'Usage token subsets exceed their totals.');
        return {
            ...base,
            cache_write_input_tokens: cacheWrite,
            reasoning_output_tokens: reasoning,
            recorded_at: new Date(at).toISOString(),
            service_tier: textField(row.service_tier, 'service_tier', 40) as string,
        };
    });
    if (new Set(usages.map((u) => u.recorded_at.slice(0, 10))).size > 1) throw new ApiError(422, 'Each batch must cover one UTC day.');
    const checkpoint = await env.DB.prepare('SELECT last_batch_sequence, last_batch_id FROM devices WHERE id = ?')
        .bind(currentDevice.id)
        .first<{ last_batch_sequence: number; last_batch_id: string | null }>();
    if (checkpoint?.last_batch_sequence === sequence && checkpoint.last_batch_id === batchId) return response(syncSettings(env));
    if (!checkpoint || checkpoint.last_batch_sequence !== sequence - 1)
        throw new ApiError(409, 'Collector checkpoint does not match this device. Restore its state before syncing.');
    const quota = quotaInput(data.quota);
    if (quota) await recordQuota(env, quota);
    const windows = await env.DB.prepare('SELECT * FROM quota_windows ORDER BY sampled_at DESC LIMIT 16').all<QuotaWindowRow>();
    const totals = contributions(usages, windows.results, now);
    const guard = 'EXISTS (SELECT 1 FROM devices WHERE id = ? AND last_batch_sequence = ?)';
    const guardArgs = [currentDevice.id, sequence - 1];
    const statements = summaryStatements(env, currentDevice.member_id, totals, guard, guardArgs);
    if (usages.length)
        statements.push(
            env.DB.prepare(
                `INSERT INTO usage_batches
        (device_id, member_id, batch_id, sequence, usage_json, contributions_json, pricing_version, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
            ).bind(
                currentDevice.id,
                currentDevice.member_id,
                batchId,
                sequence,
                JSON.stringify(usages),
                JSON.stringify(totals),
                PRICING_VERSION,
                now,
                ...guardArgs,
            ),
        );
    statements.push(
        env.DB.prepare(
            `UPDATE devices SET last_batch_sequence = ?, last_batch_id = ?, last_seen_at = ?, agent_version = ?
        WHERE id = ? AND last_batch_sequence = ?`,
        ).bind(sequence, batchId, now, version, ...guardArgs),
    );
    statements.push(env.DB.prepare('SELECT last_batch_id FROM devices WHERE id = ?').bind(currentDevice.id));
    const results = await env.DB.batch(statements);
    if ((results.at(-1)?.results[0] as { last_batch_id?: string })?.last_batch_id !== batchId)
        throw new ApiError(409, 'Another collector submitted this sequence.');
    return response(syncSettings(env));
}

async function sync(request: Request, env: Env): Promise<Response> {
    const currentDevice = await device(request, env);
    const data = await body(request);
    if (data.protocol === 2) return syncRequests(env, currentDevice, data);
    const batchId = textField(data.batch_id, 'batch_id', 64) as string;
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new ApiError(422, 'batch_id is invalid.');
    const reportedAt = timestamp(data.reported_at, 'reported_at');
    const agentVersion = textField(data.agent_version, 'agent_version', 40, true);
    if (data.usage !== undefined && !Array.isArray(data.usage)) throw new ApiError(422, 'usage is invalid.');
    const usages = ((data.usage as unknown[] | undefined) || []).map(usageInput);
    if (usages.length > 30) throw new ApiError(422, 'usage has too many entries.');
    const quota = quotaInput(data.quota);
    // Legacy counters were collected before the quota read, not after it was uploaded.
    const activityAt = quota ? Date.parse(quota.sampled_at) : reportedAt;
    const quotaWindow = quota
        ? await recordQuota(env, quota)
        : await env.DB.prepare(
              `SELECT * FROM quota_windows
               WHERE ? BETWEEN reset_at - duration_minutes * 60000 AND reset_at
               ORDER BY sampled_at DESC LIMIT 1`,
          )
              .bind(reportedAt)
              .first<QuotaWindowRow>();
    const now = Date.now();
    const statements = [
        env.DB.prepare('UPDATE devices SET last_seen_at = ?, agent_version = COALESCE(?, agent_version) WHERE id = ?').bind(
            now,
            agentVersion,
            currentDevice.id,
        ),
    ];
    const recordedUsages = usages.filter((usage) => usage.input_tokens + usage.output_tokens > 0);
    const totals = recordedUsages.reduce(
        (sum, usage) => {
            sum.input += usage.input_tokens;
            sum.output += usage.output_tokens;
            const cost = estimateMicros(usage);
            sum.cost += cost;
            if (cost === 0) sum.unknown += 1;
            return sum;
        },
        { input: 0, output: 0, cost: 0, unknown: 0 },
    );

    if (recordedUsages.length) {
        const dayStart = Math.floor(activityAt / (24 * 60 * 60 * 1000)) * 24 * 60 * 60 * 1000;
        statements.push(
            env.DB.prepare(
                `INSERT INTO member_usage_days
                     (member_id, day_start, estimated_cost_micros, input_tokens, output_tokens, unknown_entries, incomplete_entries)
                 SELECT ?, ?, ?, ?, ?, ?, 1
                 WHERE NOT EXISTS (SELECT 1 FROM usage_entries WHERE device_id = ? AND batch_id = ?)
                 ON CONFLICT(member_id, day_start) DO UPDATE SET
                     estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
                     input_tokens = input_tokens + excluded.input_tokens,
                     output_tokens = output_tokens + excluded.output_tokens,
                     unknown_entries = unknown_entries + excluded.unknown_entries,
                     incomplete_entries = incomplete_entries + 1`,
            ).bind(currentDevice.member_id, dayStart, totals.cost, totals.input, totals.output, totals.unknown, currentDevice.id, batchId),
        );

        if (quotaWindow) {
            statements.push(
                env.DB.prepare(
                    `INSERT INTO quota_window_members
                         (quota_window_id, member_id, allocation_percent, estimated_cost_micros, usage_weight, input_tokens, output_tokens, unknown_entries, incomplete_entries)
                     SELECT ?, ?, 0, ?, ?, ?, ?, ?, 1
                     WHERE NOT EXISTS (SELECT 1 FROM usage_entries WHERE device_id = ? AND batch_id = ?)
                     ON CONFLICT(quota_window_id, member_id) DO UPDATE SET
                         estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
                         usage_weight = usage_weight + excluded.estimated_cost_micros,
                         input_tokens = input_tokens + excluded.input_tokens,
                         output_tokens = output_tokens + excluded.output_tokens,
                         unknown_entries = unknown_entries + excluded.unknown_entries,
                     incomplete_entries = incomplete_entries + 1`,
                ).bind(
                    quotaWindow.id,
                    currentDevice.member_id,
                    totals.cost,
                    totals.cost,
                    totals.input,
                    totals.output,
                    totals.unknown,
                    currentDevice.id,
                    batchId,
                ),
            );
        }
    }

    for (const usage of recordedUsages) {
        statements.push(
            env.DB.prepare(
                `INSERT INTO usage_entries
                     (device_id, member_id, batch_id, model, input_tokens, cached_input_tokens, output_tokens,
                      estimated_cost_micros, reported_at, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(device_id, batch_id, model) DO NOTHING`,
            ).bind(
                currentDevice.id,
                currentDevice.member_id,
                batchId,
                usage.model,
                usage.input_tokens,
                usage.cached_input_tokens,
                usage.output_tokens,
                estimateMicros(usage),
                activityAt,
                now,
            ),
        );
    }
    await env.DB.batch(statements);
    return response({ ok: true });
}

async function prune(env: Env): Promise<void> {
    const retention = Number(env.RETENTION_DAYS || 30) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const cutoffDay = Math.floor((now - retention) / (24 * 60 * 60 * 1000)) * 24 * 60 * 60 * 1000;
    await env.DB.batch([
        env.DB.prepare('DELETE FROM usage_batches WHERE created_at < ?').bind(now - 7 * DAY),
        env.DB.prepare('DELETE FROM usage_entries WHERE reported_at < ?').bind(now - retention),
        env.DB.prepare('DELETE FROM member_usage_days WHERE day_start < ?').bind(cutoffDay),
        env.DB.prepare('DELETE FROM quota_windows WHERE reset_at < ?').bind(now - retention),
        env.DB.prepare('DELETE FROM pairings WHERE expires_at < ?').bind(now - 24 * 60 * 60 * 1000),
    ]);
}

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    if (method === 'POST' && path === '/api/reprice') {
        await viewer(request, env);
        return response({ repriced: await repriceBatch(env), pricing_version: PRICING_VERSION });
    }
    if (method === 'GET' && path === '/api/health') return response({ ok: true, usage_protocol: 2, pricing_version: PRICING_VERSION });
    if (method === 'GET' && path === '/api/login-options') return loginOptions(env);
    if (method === 'POST' && path === '/api/session') return login(request, env);
    if (method === 'DELETE' && path === '/api/session') return response({ ok: true }, 200, { 'Set-Cookie': expiredSessionCookie() });
    if (method === 'GET' && path === '/api/dashboard') return dashboard(request, env);
    if (method === 'POST' && path === '/api/members') return addMember(request, env);
    if (method === 'POST' && path === '/api/pairings') return createPairing(request, env);
    if (method === 'POST' && path === '/api/sync') return sync(request, env);

    let match = path.match(/^\/api\/members\/(\d+)$/);
    if (method === 'DELETE' && match) return deactivateMember(request, env, Number(match[1]));
    match = path.match(/^\/api\/devices\/([0-9a-f-]+)$/i);
    if (method === 'DELETE' && match) return revokeDevice(request, env, match[1]);
    match = path.match(/^\/api\/pairings\/([A-Z0-9-]+)$/i);
    if (method === 'GET' && match) return pairingDetails(request, env, match[1].toUpperCase());
    if (method === 'POST' && match) return claimPairing(request, env, match[1].toUpperCase());
    match = path.match(/^\/api\/pairings\/([A-Z0-9-]+)\/status$/i);
    if (method === 'POST' && match) return pairingStatus(request, env, match[1].toUpperCase());

    throw new ApiError(404, 'API route not found.');
}

export default {
    async fetch(request, env): Promise<Response> {
        try {
            return await route(request, env);
        } catch (error) {
            if (error instanceof ApiError) return response({ message: error.message }, error.status);
            console.error(error);
            return response({ message: 'Unexpected server error.' }, 500);
        }
    },
    async scheduled(_controller, env): Promise<void> {
        await prune(env);
    },
} satisfies ExportedHandler<Env>;

export { prune, recordQuota };
