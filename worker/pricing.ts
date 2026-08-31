import type { UsageInput } from './types';

const prices: Record<string, { input: number; cached: number; output: number }> = {
    'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
    'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
    'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
};

/** Returns an API-rate equivalent cost in millionths of a US dollar. */
export function estimateMicros(usage: UsageInput): number {
    const price = prices[usage.model];
    if (!price) return 0;

    const uncached = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
    return Math.round(uncached * price.input + usage.cached_input_tokens * price.cached + usage.output_tokens * price.output);
}
