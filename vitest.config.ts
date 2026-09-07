import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
    const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);

    return {
        plugins: [
            cloudflareTest({
                wrangler: { configPath: './wrangler.jsonc' },
                miniflare: {
                    bindings: {
                        TRACKER_PASSWORD: 'Akashi',
                        AUTH_SECRET: 'test-secret-that-is-long-enough',
                        CHATGPT_ACCOUNT_EMAIL: 'shared-account@example.com',
                        QUOTA_WEIGHT_PER_PERCENT: '10000',
                        TEST_MIGRATIONS: migrations,
                    },
                },
            }),
        ],
        test: {
            setupFiles: ['./test/setup.ts'],
        },
    };
});
