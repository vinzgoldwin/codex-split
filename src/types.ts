export interface Device {
    id: string;
    name: string;
    platform: string;
    agentVersion: string | null;
    lastSeenAt: string | null;
    online: boolean;
}

export interface Member {
    id: number;
    name: string;
    active: boolean;
    allocation: number;
    used: number;
    shareUsed: number;
    weeklyTokens: number | null;
    weeklyCost: number;
    todayCost: number;
    todayTokens: number;
    thirtyDayCost: number;
    thirtyDayTokens: number;
    devices: Device[];
}

export interface DashboardData {
    viewer: { id: number; name: string };
    account: { used: number; resetsAt: string; sampledAt: string; unattributed: number } | null;
    members: Member[];
    warningPercent: number;
}

export interface MemberOption {
    id: number;
    name: string;
}
