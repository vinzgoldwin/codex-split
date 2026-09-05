import { describe, expect, it } from 'vitest';
import { estimateMicros } from '../worker/pricing';

describe('API-equivalent pricing', () => {
    it('prices GPT-6 Astra standard token usage', () => {
        expect(
            estimateMicros({
                model: 'gpt-6-astra',
                input_tokens: 1_000_000,
                cached_input_tokens: 200_000,
                output_tokens: 100_000,
            }),
        ).toBe(13_200_000);
    });
});
