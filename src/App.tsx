import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError } from './api';
import type { DashboardData, MemberOption } from './types';

function relativeTime(value: string | null) {
    if (!value) return 'Never';
    const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
    const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
    return formatter.format(Math.round(minutes / 60), 'hour');
}

function Loading() {
    return (
        <main className="loading-shell">
            <span>CODEX / SPLIT</span>
        </main>
    );
}

function Login({ members, onLogin }: { members: MemberOption[]; onLogin: () => Promise<void> }) {
    const [memberId, setMemberId] = useState(members[0]?.id || 0);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [working, setWorking] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setWorking(true);
        setError('');
        try {
            await api('/api/session', { method: 'POST', body: JSON.stringify({ memberId, password }) });
            await onLogin();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Login failed.');
        } finally {
            setWorking(false);
        }
    }

    return (
        <main className="auth-shell">
            <form className="auth-form" onSubmit={submit}>
                <a className="wordmark" href="/">
                    CODEX / SPLIT
                </a>
                <h1>Who is using this device?</h1>
                <label htmlFor="user">Member</label>
                <select id="user" value={memberId} onChange={(event) => setMemberId(Number(event.target.value))}>
                    {members.map((member) => (
                        <option key={member.id} value={member.id}>
                            {member.name}
                        </option>
                    ))}
                </select>
                <label htmlFor="password">Tracker password</label>
                <input id="password" type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
                {error && <span className="field-error">{error}</span>}
                <button type="submit" disabled={working || !memberId}>
                    {working ? 'Checking…' : 'Continue'}
                </button>
            </form>
        </main>
    );
}

function PairDevice({ code, onDone }: { code: string; onDone: () => void }) {
    type PairingData = {
        pairing: { code: string; name: string; platform: string; arch: string | null };
        members: MemberOption[];
        currentMemberId: number;
    };
    const [data, setData] = useState<PairingData | null>(null);
    const [memberId, setMemberId] = useState(0);
    const [error, setError] = useState('');
    const [working, setWorking] = useState(false);

    useEffect(() => {
        api<PairingData>(`/api/pairings/${code}`)
            .then((result) => {
                setData(result);
                setMemberId(result.currentMemberId);
            })
            .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not load pairing.'));
    }, [code]);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setWorking(true);
        setError('');
        try {
            await api(`/api/pairings/${code}`, { method: 'POST', body: JSON.stringify({ memberId }) });
            onDone();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not connect device.');
        } finally {
            setWorking(false);
        }
    }

    if (!data && !error) return <Loading />;
    return (
        <main className="auth-shell">
            <form className="auth-form" onSubmit={submit}>
                <a className="wordmark" href="/">
                    CODEX / SPLIT
                </a>
                <h1>{data ? `Connect ${data.pairing.name}` : 'Pairing unavailable'}</h1>
                {data && (
                    <>
                        <div className="pair-meta">
                            <span>{data.pairing.code}</span>
                            <span>
                                {data.pairing.platform} {data.pairing.arch}
                            </span>
                        </div>
                        <label htmlFor="pair-user">Assign to</label>
                        <select id="pair-user" value={memberId} onChange={(event) => setMemberId(Number(event.target.value))}>
                            {data.members.map((member) => (
                                <option key={member.id} value={member.id}>
                                    {member.name}
                                </option>
                            ))}
                        </select>
                    </>
                )}
                {error && <span className="field-error">{error}</span>}
                {data && (
                    <button type="submit" disabled={working}>
                        {working ? 'Connecting…' : 'Connect device'}
                    </button>
                )}
            </form>
        </main>
    );
}

function Dashboard({ data, reload, onLogout }: { data: DashboardData; reload: () => Promise<void>; onLogout: () => void }) {
    const { viewer, account, members, warningPercent } = data;
    const [notice, setNotice] = useState('');
    const [memberName, setMemberName] = useState('');
    const [error, setError] = useState('');
    const alerts = useMemo(() => members.filter((member) => member.shareUsed >= warningPercent), [members, warningPercent]);
    const installCommand = /Windows/i.test(navigator.userAgent)
        ? `irm ${window.location.origin}/install.ps1 | iex`
        : `curl -fsSL ${window.location.origin}/install | sh`;

    useEffect(() => {
        const interval = window.setInterval(() => {
            if (document.visibilityState === 'visible') void reload();
        }, 30_000);
        return () => window.clearInterval(interval);
    }, [reload]);

    async function mutate(path: string, init: RequestInit, success: string) {
        setError('');
        try {
            const result = await api<{ message?: string }>(path, init);
            setNotice(result.message || success);
            await reload();
            return true;
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Request failed.');
            return false;
        }
    }

    async function addMember(event: FormEvent) {
        event.preventDefault();
        if (await mutate('/api/members', { method: 'POST', body: JSON.stringify({ name: memberName }) }, 'Member added.')) {
            setMemberName('');
        }
    }

    return (
        <main className="shell">
            <header className="topbar">
                <a className="wordmark" href="/">
                    CODEX / SPLIT
                </a>
                <nav className="top-actions" aria-label="Account actions">
                    <span>{viewer.name}</span>
                    <button className="text-button" onClick={onLogout}>
                        Log out
                    </button>
                </nav>
            </header>

            {notice && (
                <div className="notice success" aria-live="polite">
                    {notice}
                </div>
            )}
            {error && (
                <div className="notice error" role="alert">
                    {error}
                </div>
            )}
            {alerts.length > 0 && (
                <div className="notice warning">
                    <strong>Usage warning</strong>
                    {alerts.map((member) => `${member.name} has used ${member.shareUsed.toFixed(0)}% of their weekly share.`).join(' ')}
                </div>
            )}

            <section className="account-overview">
                <div>
                    <p className="eyebrow">Weekly account usage</p>
                    <div className="account-number">
                        {account ? account.used.toFixed(1) : '—'}
                        <span>%</span>
                    </div>
                </div>
                <div className="reset-copy">
                    {account ? (
                        <>
                            <span>
                                Resets{' '}
                                {new Intl.DateTimeFormat('en', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(
                                    new Date(account.resetsAt),
                                )}
                            </span>
                            <small>Updated {relativeTime(account.sampledAt)}</small>
                        </>
                    ) : (
                        <span>Waiting for the first connected device</span>
                    )}
                </div>
            </section>

            <section className="members-section">
                <div className="section-heading members-heading">
                    <h2>Members</h2>
                    <div className="heading-actions">
                        <details className="action-menu">
                            <summary>Add device</summary>
                            <div className="action-panel command-panel">
                                <strong>On the new device</strong>
                                <code>{installCommand}</code>
                                <span>Confirm the ChatGPT account, then choose the member using this device.</span>
                            </div>
                        </details>
                        <details className="action-menu">
                            <summary>Add member</summary>
                            <form className="action-panel" onSubmit={addMember}>
                                <label htmlFor="member-name">Name</label>
                                <input id="member-name" value={memberName} onChange={(event) => setMemberName(event.target.value)} required />
                                <button type="submit">Add member</button>
                            </form>
                        </details>
                    </div>
                </div>

                <div className="member-table" role="table" aria-label="Member usage">
                    <div className="table-row table-header" role="row">
                        <span>Member</span>
                        <span>Weekly share</span>
                        <span>Usage</span>
                        <span>Devices</span>
                        <span>30d estimate</span>
                    </div>
                    {members.map((member) => (
                        <div className="member-group" key={member.id}>
                            <div className="table-row member-row" role="row">
                                <div className="member-name">
                                    <strong>{member.name}</strong>
                                    {!member.active && <span className="inactive-mark">Inactive</span>}
                                    {member.shareUsed >= warningPercent && <span className="alert-mark">Almost out</span>}
                                    {member.active && member.id !== viewer.id && (
                                        <button
                                            className="text-button member-action"
                                            onClick={() => {
                                                if (window.confirm(`Deactivate ${member.name}?`)) {
                                                    void mutate(`/api/members/${member.id}`, { method: 'DELETE' }, 'Member deactivated.');
                                                }
                                            }}
                                        >
                                            Deactivate
                                        </button>
                                    )}
                                </div>
                                <span>{member.allocation ? `${member.allocation.toFixed(1)}%` : 'Next reset'}</span>
                                <div className="member-usage">
                                    <span>{member.used.toFixed(2)}% account</span>
                                    <div className="mini-meter">
                                        <span
                                            className={member.shareUsed >= warningPercent ? 'danger' : ''}
                                            style={{ width: `${Math.min(member.shareUsed, 100)}%` }}
                                        />
                                    </div>
                                    <small>{member.shareUsed.toFixed(0)}% of share</small>
                                </div>
                                <span>{member.devices.length} connected</span>
                                <span>${member.cost.toFixed(2)}</span>
                            </div>
                            {member.devices.map((device) => (
                                <div className="device-row" key={device.id}>
                                    <span className={device.online ? 'status-dot online' : 'status-dot'} />
                                    <span>{device.name}</span>
                                    <span>{device.platform}</span>
                                    <span>{relativeTime(device.lastSeenAt)}</span>
                                    <button
                                        className="text-button danger-text"
                                        onClick={() => {
                                            if (window.confirm(`Revoke ${device.name}?`)) {
                                                void mutate(`/api/devices/${device.id}`, { method: 'DELETE' }, 'Device revoked.');
                                            }
                                        }}
                                    >
                                        Revoke
                                    </button>
                                </div>
                            ))}
                        </div>
                    ))}
                    {account && account.unattributed > 0.001 && (
                        <div className="table-row unattributed-row">
                            <strong>Unattributed</strong>
                            <span />
                            <span>{account.unattributed.toFixed(2)}% account</span>
                            <span />
                            <span />
                        </div>
                    )}
                </div>
            </section>

            <footer>
                <span>Dollar values are API-rate equivalents, not charges.</span>
                <span>Token counters only. Content stays on each device.</span>
            </footer>
        </main>
    );
}

export default function App() {
    const [dashboard, setDashboard] = useState<DashboardData | null>(null);
    const [loginMembers, setLoginMembers] = useState<MemberOption[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [fatalError, setFatalError] = useState('');
    const pairingCode = window.location.pathname.match(/^\/pair\/([A-Z0-9-]+)$/i)?.[1]?.toUpperCase();

    const loadDashboard = useCallback(async () => {
        try {
            const data = await api<DashboardData>('/api/dashboard');
            setDashboard(data);
            setLoginMembers(null);
            setFatalError('');
        } catch (caught) {
            if (caught instanceof ApiRequestError && caught.status === 401) {
                const options = await api<{ members: MemberOption[] }>('/api/login-options');
                setDashboard(null);
                setLoginMembers(options.members);
            } else {
                setFatalError(caught instanceof Error ? caught.message : 'Could not load the tracker.');
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadDashboard();
    }, [loadDashboard]);

    async function logout() {
        await api('/api/session', { method: 'DELETE' });
        await loadDashboard();
    }

    if (loading) return <Loading />;
    if (fatalError)
        return (
            <main className="loading-shell">
                <span>{fatalError}</span>
                <button onClick={() => void loadDashboard()}>Try again</button>
            </main>
        );
    if (!dashboard && loginMembers) return <Login members={loginMembers} onLogin={loadDashboard} />;
    if (!dashboard) return <Loading />;
    if (pairingCode)
        return (
            <PairDevice
                code={pairingCode}
                onDone={() => {
                    window.history.replaceState(null, '', '/');
                    void loadDashboard();
                }}
            />
        );
    return <Dashboard data={dashboard} reload={loadDashboard} onLogout={() => void logout()} />;
}
