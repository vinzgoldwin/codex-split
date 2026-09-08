import { version as latestVersion } from '../public/downloads/latest.json';

// Compare released versions numerically; custom builds have no release ordering.
export function binaryStatus(version: string | null, latest = latestVersion) {
    if (!version) return 'Version unknown';
    if (version === 'dev') return 'Development build';
    if (!/^\d+\.\d+\.\d+$/.test(version)) return 'Custom build';
    const parts = version.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (parts[i] < latestParts[i]) return 'Update available';
        if (parts[i] > latestParts[i]) return 'Newer build';
    }
    return 'Current';
}

export function DeviceVersion({ version }: { version: string | null }) {
    const status = binaryStatus(version);
    return (
        <span
            className={`device-version${status === 'Update available' ? ' outdated' : status === 'Current' ? ' current' : ''}`}
            title={`Last reported version. Latest available: ${latestVersion}`}
        >
            {version && `${version} · `}
            {status}
        </span>
    );
}
