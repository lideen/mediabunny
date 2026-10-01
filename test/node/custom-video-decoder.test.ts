import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { ALL_FORMATS, BufferSource, CustomVideoDecoder, Input, registerDecoder,
	VideoCodec, VideoSampleSink } from '../../src/index.js';

describe('given a custom video decoder that fails', () => {
	describe('when the sample sink releases the decoder', () => {
		it.each(['init', 'decode'] as const)('should call close after %s rejects', async (stage) => {
			let active = true;
			let closes = 0;
			class FailingDecoder extends CustomVideoDecoder {
				static override supports(codec: VideoCodec) { return active && codec === 'avc'; }
				init() {
					if (stage === 'init') {
						throw new Error('Custom decoder failed');
					}
				}

				decode() { throw new Error('Custom decoder failed'); }
				flush() {}
				close() { closes++; }
			}
			registerDecoder(FailingDecoder);
			try {
				using input = new Input({ formats: ALL_FORMATS, source: new BufferSource(
					readFileSync(new URL('../public/video.mp4', import.meta.url)),
				) });
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getSample(0)).rejects.toThrow('Custom decoder failed');
				await setImmediate();
				expect(closes).toBe(1);
			} finally {
				active = false;
			}
		});
	});
});
