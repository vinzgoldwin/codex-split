export class ApiRequestError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    });
    const data = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) throw new ApiRequestError(response.status, data.message || 'Request failed.');
    return data;
}
