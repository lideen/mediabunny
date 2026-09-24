import { describe, expect, it } from 'vitest';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import { BufferSource, Input, MXF, VideoSampleSink } from '../../src/index.js';

describe('given the bundled optional HTJ2K decoder in a browser', () => {
	describe('when decoding complete RGB16 MXF frames', () => {
		it('should load embedded WASM and return stable RGBA8 with BT.709 metadata', async () => {
			const response = await fetch(new URL('../fixtures/htj2k/rgb16.mxf', import.meta.url));
			expect(response.ok).toBe(true);
			using input = new Input({ source: new BufferSource(await response.arrayBuffer()), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.canDecode()).toBe(false);
			registerHtj2kDecoder();
			expect(await track.canDecode()).toBe(true);
			const sink = new VideoSampleSink(track);
			using first = (await sink.getSample(0))!;
			using next = (await sink.getSample(1 / 24))!;
			const bytes = new Uint8Array(first.allocationSize());
			await first.copyTo(bytes);
			expect([...bytes.slice(0, 32)]).toEqual([
				0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
				0, 0, 255, 255, 17, 83, 201, 255, 128, 64, 32, 255, 254, 1, 127, 255,
			]);
			expect([first.timestamp, next.timestamp]).toEqual([0, 1 / 24]);
			expect(first.colorSpace).toMatchObject({
				primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true,
			});
			const frame = first.toVideoFrame();
			try {
				expect(frame.colorSpace.toJSON()).toEqual({
					primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true,
				});
			} finally {
				frame.close();
			}
		});
	});
});
