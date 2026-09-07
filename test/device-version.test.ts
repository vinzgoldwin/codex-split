import { describe, expect, it } from 'vitest';
import { binaryStatus } from '../src/DeviceVersion';

describe('device binary status', () => {
    it.each([
        ['0.1.0', 'Update available'],
        ['0.2.0', 'Current'],
        ['0.10.0', 'Newer build'],
        [null, 'Version unknown'],
        ['dev', 'Development build'],
        ['0.2.0-rc.1', 'Custom build'],
    ])('labels %s as %s', (version, expected) => {
        expect(binaryStatus(version, '0.2.0')).toBe(expected);
    });
    it('compares version components numerically', () => {
        expect(binaryStatus('0.9.0', '0.10.0')).toBe('Update available');
        expect(binaryStatus('1.0.0', '0.10.0')).toBe('Newer build');
        expect(binaryStatus('0.2.1', '0.2.0')).toBe('Newer build');
    });
});
