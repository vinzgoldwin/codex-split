import type { Env as WorkerEnv } from '../worker/types';

declare global {
    namespace Cloudflare {
        interface Env extends WorkerEnv {
            TEST_MIGRATIONS: D1Migration[];
        }
    }
}

export {};
