import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	BufferSource, CustomVideoDecoder, Input, MXF, registerDecoder, VideoSample, VideoSampleSink,
	type PreparedVideoDecodeInput, type VideoDecodePacketReader,
} from '../../src/index.js';
import { makeMxf } from './mxf-fixture.js';
import { extractReduced } from '../../packages/htj2k/src/reduced.js';

const data = readFileSync(new URL('../fixtures/htj2k/rpcl-193x131-16.j2c', import.meta.url));
const makeInput = () => new Input({ formats: [MXF], source: new BufferSource(makeMxf({
	htj2k: { data, bits: 16, width: 193, height: 131 }, videoOnly: true,
}).data) });

describe('given a custom reduced decoder preparation pair', () => {
	it('should reject an extractor budget before payload I/O or native decoding without a fallback', async () => {
		let enabled = true;
		let payloadReads = 0;
		let nativeCalls = 0;
		class Decoder extends CustomVideoDecoder {
			static override supports() { return enabled; }
			init() {}
			decode() { throw new Error('Unexpected full-frame fallback'); }
			override decodeReduced() { throw new Error('Unexpected serial fallback'); }
			override async prepareReduced(reader: VideoDecodePacketReader) {
				const result = await extractReduced({ ...reader, read: (start, end) => {
					payloadReads++;
					return reader.read(start, end);
				} }, { width: 25, height: 17 }, { width: 193, height: 131, bits: 16 }, { maxWorkingBytes: 65536 });
				return { byteLength: result.data.length, dispose() {} };
			}

			override decodePrepared() { nativeCalls++; }
			flush() {}
			close() {}
		}
		registerDecoder(Decoder);
		using input = makeInput();
		try {
			const track = (await input.getPrimaryVideoTrack())!;
			const iterator = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } }).samples();
			await expect(iterator.next()).rejects.toThrow('preparation working byte budget');
			await iterator.return();
			expect(payloadReads).toBe(0);
			expect(nativeCalls).toBe(0);
		} finally {
			enabled = false;
		}
	});

	it('should keep a decoding input alive until it settles while disposing ready inputs on return', async () => {
		let enabled = true;
		let release!: () => void;
		let ready!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const secondReady = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const inputs: PreparedVideoDecodeInput[] = [];
		let decoding = 0;
		let closed = 0;
		class Decoder extends CustomVideoDecoder {
			static override supports() { return enabled; }
			init() {}
			decode() { throw new Error('Full decoding must not be used'); }
			override decodeReduced() { throw new Error('Serial reduced decoding must not be used'); }
			override async prepareReduced(reader: VideoDecodePacketReader) {
				const bytes = await reader.read(0, 2);
				let owned = bytes;
				const input = {
					get byteLength() { return owned.length; },
					dispose() { owned = new Uint8Array(); },
				};
				inputs.push(input);
				if (inputs.length === 2) ready();
				return input;
			}

			override async decodePrepared(input: PreparedVideoDecodeInput) {
				decoding++;
				await gate;
				expect(input.byteLength).toBe(2);
				this.onSample(new VideoSample(new Uint8Array(4), {
					format: 'RGBA', codedWidth: 1, codedHeight: 1, timestamp: 0, duration: 0.04,
				}));
			}

			flush() {}
			close() { closed++; }
		}
		registerDecoder(Decoder);
		using input = makeInput();
		const track = (await input.getPrimaryVideoTrack())!;
		const iterator = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } }).samples();
		const pending = iterator.next();
		try {
			await secondReady;
			await iterator.return();
			expect(inputs.map(input => input.byteLength)).toEqual([2, 0]);
			expect(closed).toBe(0);
			release();
			expect((await pending).done).toBe(true);
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(inputs.map(input => input.byteLength)).toEqual([0, 0]);
			expect(decoding).toBe(1);
			expect(closed).toBe(1);
		} finally {
			enabled = false;
			release();
			await iterator.return();
		}
	});

	it.each(['prepare', 'decode'] as const)('should reject an incomplete %s pair', async (half) => {
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
			const track = (await input.getPrimaryVideoTrack())!;
			await expect(new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } }).getSample(0))
				.rejects.toThrow('both prepareReduced and decodePrepared');
			expect(initialized).toBe(false);
		} finally {
			enabled = false;
		}
	});
});
