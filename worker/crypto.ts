const encoder = new TextEncoder();
const SESSION_COOKIE = 'codex_split_session';

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
    const padded = value
        .replaceAll('-', '+')
        .replaceAll('_', '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function secretMatches(actual: string, expected: string, keySecret: string): Promise<boolean> {
    const key = await hmacKey(keySecret);
    const expectedSignature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
    return crypto.subtle.verify('HMAC', key, expectedSignature, encoder.encode(actual));
}

export async function sha256(value: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sessionCookie(memberId: number, secret: string): Promise<string> {
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const payload = `${memberId}:${expiresAt}`;
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload)));
    const value = `${toBase64Url(encoder.encode(payload))}.${toBase64Url(signature)}`;
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`;
}

export function expiredSessionCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function sessionMemberId(request: Request, secret: string): Promise<number | null> {
    const cookie = request.headers
        .get('Cookie')
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
        ?.slice(SESSION_COOKIE.length + 1);
    if (!cookie) return null;

    const [encodedPayload, encodedSignature] = cookie.split('.');
    if (!encodedPayload || !encodedSignature) return null;

    try {
        const payloadBytes = fromBase64Url(encodedPayload);
        const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(encodedSignature), payloadBytes);
        if (!valid) return null;

        const [memberId, expiresAt] = new TextDecoder().decode(payloadBytes).split(':').map(Number);
        return Number.isInteger(memberId) && expiresAt > Date.now() ? memberId : null;
    } catch {
        return null;
    }
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(value: string, secret: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(value)));
    return `${toBase64Url(iv)}.${toBase64Url(encrypted)}`;
}

export async function decrypt(value: string, secret: string): Promise<string> {
    const [encodedIv, encodedCipher] = value.split('.');
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(encodedIv) },
        await encryptionKey(secret),
        fromBase64Url(encodedCipher),
    );
    return new TextDecoder().decode(decrypted);
}
