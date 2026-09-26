import { describe, expect, it } from 'vitest';
import { VideoSample } from '../../src/index.js';

describe('given owned I422 video samples', () => {
	describe('when preserving scan metadata across clones', () => {
		it.each(['unknown', 'progressive', 'interlaced-top-first', 'interlaced-bottom-first'] as const)(
			'should retain %s without changing pixels, timing or geometry', async (scan) => {
				const pixels = Uint8Array.from({ length: 16 }, (_, i) => i);
				const sample = new VideoSample(pixels, {
					format: 'I422', codedWidth: 4, codedHeight: 2, timestamp: 0.08, duration: 0.04, scan,
				});
				using clone = sample.clone();
				sample.close();
				expect([clone.scan, clone.format, clone.codedWidth, clone.codedHeight, clone.timestamp, clone.duration])
					.toEqual([scan, 'I422', 4, 2, 0.08, 0.04]);
				const copy = new Uint8Array(clone.allocationSize());
				await clone.copyTo(copy);
				expect(copy).toEqual(pixels);
			},
		);

		it('should leave unspecified scan unknown rather than assume progressive', () => {
			using sample = new VideoSample(new Uint8Array(16), {
				format: 'I422', codedWidth: 4, codedHeight: 2, timestamp: 0,
			});
			expect(sample.scan).toBe('unknown');
			using clone = sample.clone();
			expect(clone.scan).toBe('unknown');
		});
	});
});
