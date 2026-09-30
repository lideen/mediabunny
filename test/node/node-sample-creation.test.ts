import { describe, expect, it, test } from 'vitest';
import { AudioSample, VideoSample } from '../../src/sample.js';

describe('given raw video samples with scan metadata', () => {
	it('should preserve explicit field order on clones and default unspecified scan to unknown', () => {
		for (const scan of [undefined, 'unknown', 'progressive', 'interlaced-top-first',
			'interlaced-bottom-first'] as const) {
			using sample = new VideoSample(new Uint8Array(6), {
				codedWidth: 2, codedHeight: 2, format: 'I420', timestamp: 0, scan,
			});
			using clone = sample.clone();
			sample.close();
			expect(clone.scan).toBe(scan ?? 'unknown');
		}
	});
});

test('VideoSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new VideoSample(bytes, {
		codedWidth: 1280,
		codedHeight: 720,
		format: 'RGBA',
		timestamp: 0,
	});

	sample.close();
});

test('AudioSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new AudioSample({
		data: bytes,
		numberOfChannels: 2,
		format: 's16',
		sampleRate: 48000,
		timestamp: 0,
	});

	sample.close();
});
