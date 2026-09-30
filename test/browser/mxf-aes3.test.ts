import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';

describe('given ST 331 AES3 in independent D-10 MXF over HTTP', () => {
	it('should decode exact 24-bit PCM without a native audio or video decoder', async () => {
		using input = new Input({ source: new UrlSource('/mxf-aes3-24bit-ntsc.mxf'), formats: ALL_FORMATS });
		const video = (await input.getPrimaryVideoTrack())!;
		expect(await video.getCodec()).toBeNull();
		expect(await video.canDecode()).toBe(false);
		const audio = (await input.getPrimaryAudioTrack())!;
		expect(await audio.canDecode()).toBe(true);
		const metadata = (await new EncodedPacketSink(audio).getFirstPacket({ metadataOnly: true }))!;
		expect(metadata.byteLength).toBe(38448);
		let frames = 0;
		const counts: number[] = [];
		const pcm = new Uint8Array(8008 * 8 * 3);
		for await (using sample of new AudioSampleSink(audio).samples()) {
			expect(sample.timestamp).toBeCloseTo(frames / 48000, 6);
			const values = new Float32Array(sample.numberOfFrames * 8);
			sample.copyTo(values, { planeIndex: 0, format: 'f32' });
			for (const [i, value] of values.entries()) {
				const integer = value * 8388608;
				const offset = (frames * 8 + i) * 3;
				pcm[offset] = integer;
				pcm[offset + 1] = integer >>> 8;
				pcm[offset + 2] = integer >>> 16;
			}
			counts.push(sample.numberOfFrames);
			frames += sample.numberOfFrames;
		}
		expect(counts).toEqual([1602, 1601, 1602, 1601, 1602]);
		expect(frames).toBe(8008);
		// Same independent FFmpeg PCM golden and fixture provenance as node/mxf-aes3.test.ts.
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pcm));
		expect(Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''))
			.toBe('4e2e034f055918f02fbbbf9d1f78b7f356d00a482713bd8a15c4ca8adf4811c0');
	});
});
