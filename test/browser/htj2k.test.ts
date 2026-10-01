import { describe, expect, it } from 'vitest';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import { BufferSource, Input, MXF, VideoSampleSink } from '../../src/index.js';

// Authored RGB16 edge pattern with two distinct phases, wrapped as five OP1a frames at 24 fps.
// See test/node/htj2k.test.ts for source values and packages/htj2k/README.md for the fixture license.
describe('given the bundled optional HTJ2K decoder in a browser', () => {
	describe('when decoding complete RGB16 MXF frames', () => {
		it('should load embedded WASM and return stable RGBA8 with BT.709 metadata', async () => {
			const response = await fetch('/htj2k-rgb16-edges.mxf');
			expect(response.ok).toBe(true);
			using input = new Input({ source: new BufferSource(await response.arrayBuffer()), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.canDecode()).toBe(false);
			registerHtj2kDecoder();
			expect(await track.canDecode()).toBe(true);
			const sink = new VideoSampleSink(track);
			using first = (await sink.getSample(0))!;
			using next = (await sink.getSample(1 / 24))!;
			input.dispose();
			const bytes = new Uint8Array(first.allocationSize());
			await first.copyTo(bytes);
			const row = [
				0, 0, 0, 255, 0, 0, 0, 255, 1, 1, 1, 255, 2, 2, 255, 255,
				255, 255, 255, 255, 127, 128, 128, 255, 0, 1, 2, 255, 254, 255, 255, 255,
			];
			expect([...bytes]).toEqual(Array.from({ length: 4 }, () => row).flat());
			const nextBytes = new Uint8Array(next.allocationSize());
			await next.copyTo(nextBytes);
			const nextRow = [
				254, 255, 255, 255, 0, 1, 2, 255, 127, 128, 128, 255, 255, 255, 255, 255,
				2, 2, 255, 255, 1, 1, 1, 255, 0, 0, 0, 255, 0, 0, 0, 255,
			];
			expect([...nextBytes]).toEqual(Array.from({ length: 4 }, () => nextRow).flat());
			expect([first.codedWidth, first.codedHeight, first.timestamp, first.duration, next.timestamp])
				.toEqual([8, 4, 0, 1 / 24, 1 / 24]);
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
