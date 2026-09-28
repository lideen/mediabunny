import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { BufferSource, CustomSource, Input, MXF, registerDecoder, VideoSampleSink } from '../../src/index.js';
import { Mpeg2Decoder } from '@mediabunny/mpeg2';
import manifest from '../fixtures/mpeg2/open/open422.json' with { type: 'json' };
import regression from '../fixtures/mpeg2/wasm-idct-v1.json' with { type: 'json' };

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
class GatedMpeg2Decoder extends Mpeg2Decoder {
	static gate = Promise.resolve();
	static entered = () => {};
	override async init() {
		GatedMpeg2Decoder.entered();
		await GatedMpeg2Decoder.gate;
		await super.init();
	}
}
registerDecoder(GatedMpeg2Decoder);
const bytes = () => readFileSync(new URL('../fixtures/mpeg2/open/open422.mxf', import.meta.url));

describe('given an open-GOP range with asynchronously initialized real MPEG-2 decoding', () => {
	it.each(['release', 'cancel', 'error'] as const)(
		'should handle %s while a cold I and two output-free header discards fill the queue', async (action) => {
			const gate = deferred();
			const initEntered = deferred();
			const nextPictureRead = deferred();
			GatedMpeg2Decoder.gate = gate.promise;
			GatedMpeg2Decoder.entered = initEntered.resolve;
			const data = bytes();
			const nextPicture = Number(manifest.packets[15]!.pos) + 20;
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => data.length, prefetchProfile: 'none', maxCacheSize: 0,
				read: (start, end) => {
					if (start <= nextPicture && end > nextPicture) nextPictureRead.resolve();
					return data.subarray(start, end);
				},
			}) });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			const range = sink.samples(24 / 25, 28 / 25);
			const collect = (async () => {
				const frames: { timestamp: number; duration: number; hash: string }[] = [];
				for await (const sample of range) {
					try {
						const pixels = new Uint8Array(sample.allocationSize());
						await sample.copyTo(pixels);
						frames.push({ timestamp: sample.timestamp, duration: sample.duration,
							hash: createHash('sha256').update(pixels).digest('hex') });
					} finally {
						sample.close();
					}
				}
				return frames;
			})();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const completed = Promise.race([collect, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Range made no progress after initialization')), 2000);
			})]);
			try {
				await Promise.all([initEntered.promise, nextPictureRead.promise]);
				// Drain the current turn after P15 was fetched. Initialization is still gated, so I12/B13/B14
				// cannot emit output and the pump has reached its capacity wait before the gate is released.
				await setImmediate();
				if (action === 'error') {
					const rejected = expect(completed).rejects.toThrow('Gated initialization failed');
					gate.reject(new Error('Gated initialization failed'));
					await rejected;
				} else if (action === 'cancel') {
					await range.return();
					expect(await completed).toEqual([]);
				} else {
					gate.resolve();
					expect(await completed).toEqual([24, 25, 26, 27].map(ordinal => ({
						timestamp: ordinal / 25, duration: 1 / 25,
						hash: regression.cases.open422.frames[ordinal]!.sha256,
					})));
				}
			} finally {
				clearTimeout(timer);
				await range.return();
				gate.resolve();
				GatedMpeg2Decoder.gate = Promise.resolve();
				GatedMpeg2Decoder.entered = () => {};
			}
		},
	);

	it('should include the first pictures for negative range starts but not negative point selections', async () => {
		using input = new Input({ formats: [MXF], source: new BufferSource(bytes()) });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		for (const start of [-0.1, undefined]) {
			const timestamps: number[] = [];
			for await (const sample of sink.samples(start, 0.12)) {
				timestamps.push(sample.timestamp);
				sample.close();
			}
			expect(timestamps).toEqual([0, 0.04, 0.08]);
		}
		expect(await sink.getSample(-0.1)).toBeNull();
		for await (const sample of sink.samplesAtTimestamps([-0.1])) expect(sample).toBeNull();
	});
});
