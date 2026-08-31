export interface Env {
    DB: D1Database;
    TRACKER_PASSWORD: string;
    AUTH_SECRET: string;
    CHATGPT_ACCOUNT_EMAIL: string;
    TRACKER_WARNING_PERCENT: string;
    RETENTION_DAYS: string;
}

export interface MemberRow {
    id: number;
    name: string;
    active: number;
}

export interface DeviceRow {
    id: string;
    member_id: number;
    name: string;
    platform: string;
    last_seen_at: number | null;
}

export interface QuotaWindowRow {
    id: number;
    reset_at: number;
    duration_minutes: number;
    used_percent: number;
    sampled_at: number;
}

export interface UsageInput {
    model: string;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
}

export interface QuotaInput {
    used_percent: number;
    window_duration_mins: number;
    resets_at: string;
    sampled_at: string;
}
