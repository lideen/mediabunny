import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';

describe('given HEVC MXF on a platform with a native HEVC decoder', () => {
	describe.each([
		['main42210', 16, 5 / 3],
		['sar-absent', 12, 16 / 9],
		['sar-unspecified', 12, 16 / 9],
		['vui-absent', 12, 16 / 9],
		['main10-one-picture', 1, 4 / 3],
		['main10-long-term', 1, 4 / 3],
	] as const)('when decoding %s through the public packet API', (name, count, aspect) => {
		it('should produce every native frame with the container display aspect', async (context) => {
			using input = new Input({ source: new UrlSource(`/mxf-hevc-${name}.mxf`), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			const config = (await track.getDecoderConfig())!;
			if (!(await VideoDecoder.isConfigSupported(config)).supported) {
				context.skip();
			}
			const frames: { timestamp: number; width: number; height: number }[] = [];
			let error: DOMException | null = null;
			const decoder = new VideoDecoder({
				output: (frame) => {
					frames.push({ timestamp: frame.timestamp, width: frame.displayWidth, height: frame.displayHeight });
					frame.close();
				},
				error: (value) => { error = value; },
			});
			try {
				decoder.configure(config);
				for await (const packet of new EncodedPacketSink(track).packets()) {
					decoder.decode(packet.toEncodedVideoChunk());
				}
				await decoder.flush();
				expect(error).toBeNull();
				expect(frames).toHaveLength(count);
				for (const [index, frame] of frames.entries()) {
					expect(frame.timestamp).toBe(index * 40000);
					expect(frame.width / frame.height).toBeCloseTo(aspect, 2);
				}
			} finally {
				if (decoder.state !== 'closed') {
					decoder.close();
				}
			}
		});
	});
});
