import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import {
	BufferSource, CustomVideoDecoder, Input, MXF, registerDecoder, VideoSample, VideoSampleSink,
	type PreparedVideoDecodeInput, type VideoDecodePacketReader, type VideoPreparationLimits,
	type ReducedVideoDecodeRequest,
} from '../../src/index.js';
import { makeMxf } from './mxf-fixture.js';

// CC0-1.0 deterministic RPCL fixture. Generation and copyright are recorded in htj2k-reduced.test.ts.
const data = new Uint8Array(readFileSync(new URL('../public/htj2k-rpcl-193x131-16.j2c', import.meta.url)));
const makeInput = () => new Input({ formats: [MXF], source: new BufferSource(makeMxf({
	htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true, editRate: [25, 1],
}).data) });
const reducedResolution = { width: 25, height: 17 };
const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
const sample = (timestamp: number) => new VideoSample(new Uint8Array(4), {
	format: 'RGBA', codedWidth: 1, codedHeight: 1, timestamp, duration: 0.04,
});

describe('given a custom reduced decoder', () => {
	describe('when preparation hooks are absent or incomplete', () => {
		it.each(['prepare', 'decode'] as const)('should reject an incomplete %s pair before init', async (half) => {
			let enabled = true;
			let initialized = false;
			class Decoder extends CustomVideoDecoder {
				static override supports() { return enabled; }
				init() { initialized = true; }
				decode() {}
				override decodeReduced() {}
				flush() {}
				close() {}
			}
			if (half === 'prepare') {
				Decoder.prototype.prepareReduced = async () => ({ byteLength: 0, dispose() {} });
			} else {
				Decoder.prototype.decodePrepared = () => {};
			}
			registerDecoder(Decoder);
			using input = makeInput();
			try {
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!, { reducedResolution });
				await expect(sink.getSample(0))
					.rejects.toThrow('both prepareReduced and decodePrepared');
				expect(initialized).toBe(false);
			} finally {
				enabled = false;
			}
		});

		it('should decode serially with stable packet-relative reads, bounds and cancellation', async () => {
			let enabled = true;
			let reader!: VideoDecodePacketReader;
			let decoding = false;
			class Decoder extends CustomVideoDecoder {
				static override supports() { return enabled; }
				init() {}
				decode() { throw new Error('Unexpected full-frame fallback'); }
				override async decodeReduced(value: VideoDecodePacketReader) {
					expect(decoding).toBe(false);
					decoding = true;
					reader = value;
					expect([reader.byteLength, reader.timestamp, reader.duration, reader.sequenceNumber])
						.toEqual([data.length, reader.sequenceNumber * 0.04, 0.04, reader.sequenceNumber]);
					const bytes = await reader.read(0, 8);
					expect(bytes).toEqual(data.subarray(0, 8));
					bytes.fill(0);
					expect(await reader.read(0, 8)).toEqual(data.subarray(0, 8));
					expect(await reader.read(0, 0)).toEqual(new Uint8Array());
					for (const [start, end] of [[-1, 1], [0, data.length + 1], [2, 1], [0.5, 2]]) {
						await expect(reader.read(start!, end!)).rejects.toThrow('bounds');
					}
					this.onSample(sample(reader.timestamp));
					decoding = false;
				}

				flush() {}
				close() {}
			}
			registerDecoder(Decoder);
			using input = makeInput();
			try {
				const timestamps = [];
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!, { reducedResolution });
				for await (const frame of sink.samples()) {
					timestamps.push(frame.timestamp);
					frame.close();
				}
				expect(timestamps).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
				await expect(reader.read(0, 2)).rejects.toThrow();
				await expect(reader.read(0, 0)).rejects.toThrow();
			} finally {
				enabled = false;
			}
		});
	});

	describe('when preparations overlap native decoding', () => {
		it.each(['finish', 'return', 'error'] as const)('should bound slots and release inputs on %s', async (mode) => {
			let enabled = true;
			const release = gate();
			const secondReady = gate();
			const closed = gate();
			const inputs: (PreparedVideoDecodeInput & { timestamp: number })[] = [];
			const decoded: number[] = [];
			let active = false;
			class Decoder extends CustomVideoDecoder {
				static override supports() { return enabled; }
				init() {}
				decode() { throw new Error('Unexpected full-frame fallback'); }
				override decodeReduced() { throw new Error('Unexpected serial fallback'); }
				override async prepareReduced(
					reader: VideoDecodePacketReader, request: Readonly<ReducedVideoDecodeRequest>,
					limits: Readonly<VideoPreparationLimits>) {
					expect(request).toEqual(reducedResolution);
					expect(limits.maxWorkingBytes).toBe(64 * 1024 * 1024);
					let bytes = await reader.read(0, 2);
					const input = { timestamp: reader.timestamp,
						get byteLength() { return bytes.length; },
						dispose() { bytes = new Uint8Array(); },
					};
					inputs.push(input);
					if (inputs.length === 2) {
						secondReady.resolve();
					}
					return input;
				}

				override async decodePrepared(input: PreparedVideoDecodeInput) {
					expect(active).toBe(false);
					active = true;
					const timestamp = inputs.find(value => value === input)!.timestamp;
					decoded.push(timestamp);
					await release.promise;
					expect(input.byteLength).toBe(2);
					if (mode === 'error') {
						throw new Error('Native decode failed');
					}
					this.onSample(sample(timestamp));
					active = false;
				}

				flush() {}
				close() { closed.resolve(); }
			}
			registerDecoder(Decoder);
			using input = makeInput();
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!, { reducedResolution });
			const iterator = sink.samples();
			const pending = iterator.next();
			void pending.catch(() => {});
			try {
				await secondReady.promise;
				await setImmediate();
				expect(inputs.length).toBe(2);
				expect(decoded).toEqual([0]);
				if (mode === 'return') {
					await iterator.return();
					expect(inputs.map(value => value.byteLength)).toEqual([2, 0]);
					const state = await Promise.race([closed.promise.then(() => 'closed'), setImmediate('pending')]);
					expect(state).toBe('pending');
				}
				release.resolve();
				if (mode === 'error') {
					await expect(pending).rejects.toThrow('Native decode failed');
				} else if (mode === 'return') {
					expect((await pending).done).toBe(true);
				} else {
					const timestamps = [(await pending).value!.timestamp];
					(await pending).value!.close();
					for await (const frame of iterator) {
						timestamps.push(frame.timestamp);
						frame.close();
					}
					expect(timestamps).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
				}
				await closed.promise;
				expect(inputs.map(value => value.byteLength)).toEqual(inputs.map(() => 0));
				expect(decoded).toEqual(mode === 'finish' ? [0, 0.04, 0.08, 0.12, 0.16] : [0]);
			} finally {
				enabled = false;
				release.resolve();
				await iterator.return();
			}
		});

		it.each(['oversize', 'late'] as const)('should dispose %s results without decoding them', async (mode) => {
			let enabled = true;
			const entered = gate();
			const release = gate();
			const closed = gate();
			let prepared = 0;
			let disposed = 0;
			class Decoder extends CustomVideoDecoder {
				static override supports() { return enabled; }
				init() {}
				decode() { throw new Error('Unexpected full-frame fallback'); }
				override decodeReduced() { throw new Error('Unexpected serial fallback'); }
				override async prepareReduced(_reader: VideoDecodePacketReader, _request: ReducedVideoDecodeRequest,
					limits: VideoPreparationLimits) {
					prepared++;
					entered.resolve();
					await release.promise;
					let size = mode === 'oversize' ? limits.maxWorkingBytes + 1 : 1;
					return {
						get byteLength() { return size; },
						dispose() {
							if (size) {
								disposed++;
								size = 0;
							}
						},
					};
				}

				override decodePrepared() { throw new Error('Rejected input reached native decoder'); }
				flush() {}
				close() { closed.resolve(); }
			}
			registerDecoder(Decoder);
			using input = makeInput();
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!, { reducedResolution });
			const iterator = sink.samples();
			const pending = iterator.next();
			try {
				await entered.promise;
				if (mode === 'late') {
					await iterator.return();
				}
				release.resolve();
				if (mode === 'oversize') {
					await expect(pending).rejects.toThrow('working byte budget');
				} else {
					expect((await pending).done).toBe(true);
				}
				await closed.promise;
				expect(disposed).toBe(prepared);
			} finally {
				enabled = false;
				release.resolve();
				await iterator.return();
			}
		});
	});
});
