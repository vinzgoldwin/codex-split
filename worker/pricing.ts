import type { UsageInput, RequestUsage } from './types';

export const PRICING_VERSION = '2026-09-23.1';

const prices: Record<string, { input: number; cached: number; output: number }> = {
    'gpt-6-astra': { input: 10, cached: 1, output: 50 },
    'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
    'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
    'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
    'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
    'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
};

function priceFor(model: string) {
    const key = model === 'gpt-5.6' ? 'gpt-5.6-sol' : model;
    return Object.hasOwn(prices, key) ? prices[key] : undefined;
}

export function hasModelPrice(model: string): boolean {
    return priceFor(model) !== undefined;
}

/** Returns an API-rate equivalent cost in millionths of a US dollar. */
export function estimateMicros(usage: UsageInput): number {
    const price = priceFor(usage.model);
    if (!price) return 0;

    const uncached = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
    return Math.round(uncached * price.input + usage.cached_input_tokens * price.cached + usage.output_tokens * price.output);
}

/** Request facts are retained; all price rules belong on the server. */
export function estimateRequestMicros(usage: RequestUsage): number {
    const price = priceFor(usage.model);
    if (!price) return 0;
    const long = usage.input_tokens > 272_000;
    const fast = usage.service_tier === 'priority' || usage.service_tier === 'fast';
    const inputMultiplier = long ? 2 : 1;
    const outputMultiplier = long ? 1.5 : 1;
    const uncached = Math.max(0, usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens);
    const inputCost = uncached * price.input + usage.cached_input_tokens * price.cached + usage.cache_write_input_tokens * price.input * 1.25;
    // Reasoning tokens are a subset of output_tokens, not an additional charge.
    return Math.round((inputCost * inputMultiplier + usage.output_tokens * price.output * outputMultiplier) * (fast ? 2 : 1));
}

/** A relative attribution estimate, not OpenAI's charged-credit ledger. */
export function estimateUsageWeight(usage: RequestUsage): number {
    const standard = estimateRequestMicros({ ...usage, service_tier: 'default' });
    return Math.round(standard * (usage.service_tier === 'fast' || usage.service_tier === 'priority' ? 2.5 : 1));
}
