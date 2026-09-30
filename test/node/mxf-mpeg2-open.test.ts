import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
	Input, BufferSource, CustomSource, MXF, EncodedPacketSink, VideoSampleSink, EncodedPacket,
	CustomVideoDecoder, registerDecoder, type VideoCodec,
} from '../../src/index.js';
import manifest from '../fixtures/mpeg2/open/open422.json' with { type: 'json' };
import interlaced from '../fixtures/mpeg2/open/interlaced422.json' with { type: 'json' };

const fixture = (name = 'open422') => readFileSync(new URL(`../fixtures/mpeg2/open/${name}.mxf`, import.meta.url));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// This external-decoder double records packet delivery only. It never produces decoded samples.
class RecordingDecoder extends CustomVideoDecoder {
	static enabled = false;
	static packets: { kind: 'decode' | 'preroll'; ordinal: number; hash: string }[] = [];
	static override supports(codec: VideoCodec) {
		return this.enabled && codec === 'mpeg2';
	}

	init() {}
	decode(packet: EncodedPacket) {
		RecordingDecoder.packets.push({ kind: 'decode', ordinal: packet.sequenceNumber, hash: hash(packet.data) });
	}

	override decodePreroll(packet: EncodedPacket) {
		RecordingDecoder.packets.push({ kind: 'preroll', ordinal: packet.sequenceNumber, hash: hash(packet.data) });
	}

	flush() {}
	close() {}
}

class NoPrerollDecoder extends CustomVideoDecoder {
	static enabled = false;
	static override supports(codec: VideoCodec) {
		return this.enabled && codec === 'mpeg2';
	}

	init() {}
	decode() {}
	flush() {}
	close() {}
}
registerDecoder(RecordingDecoder);
registerDecoder(NoPrerollDecoder);

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

const controlledDecoder = (failure?: 'init' | 'preroll' | 'preroll rejection') => {
	const events: string[] = [];
	const initEntered = deferred();
	const initGate = deferred();
	const prerollEntered = deferred();
	const prerollGate = deferred();
	const flushEntered = deferred();
	const flushGate = deferred();
	const closed = deferred();
	const error = new Error(`Asynchronous ${failure} failure`);
	let enabled = true;
	class ControlledDecoder extends CustomVideoDecoder {
		static override supports(codec: VideoCodec) {
			return enabled && codec === 'mpeg2';
		}

		async init() {
			events.push('init:start');
			initEntered.resolve();
			await initGate.promise;
			events.push('init:end');
			if (failure === 'init') {
				this.onError(error);
			}
		}

		decode(packet: EncodedPacket) {
			events.push(`decode:${packet.sequenceNumber}`);
		}

		override async decodePreroll(packet: EncodedPacket) {
			events.push(`preroll:${packet.sequenceNumber}:start`);
			prerollEntered.resolve();
			await prerollGate.promise;
			events.push(`preroll:${packet.sequenceNumber}:end`);
			if (failure === 'preroll rejection') {
				throw error;
			}
			if (failure === 'preroll') {
				this.onError(error);
			}
		}

		async flush() {
			events.push('flush:start');
			flushEntered.resolve();
			await flushGate.promise;
			events.push('flush:end');
		}

		close() {
			events.push('close');
			closed.resolve();
		}
	}
	registerDecoder(ControlledDecoder);
	return {
		events, initEntered, initGate, prerollEntered, prerollGate, flushEntered, flushGate, closed, error,
		disable: () => {
			enabled = false;
		},
	};
};

const coldLeadingDelivery = [
	'decode:12', 'preroll:13:start', 'preroll:13:end', 'preroll:14:start', 'preroll:14:end',
	'decode:15', 'decode:16', 'decode:17', 'decode:18', 'decode:19', 'decode:20', 'decode:21',
	'decode:22', 'decode:23', 'decode:24', 'decode:25',
];

describe('given authored 4:2:2 open GOPs with a leading-B-only matrix update', () => {
	describe('when extracting progressive and interlaced frame pictures', () => {
		it.each([['open422', manifest], ['interlaced422', interlaced]] as const)(
			'should preserve every %s packet and report visible frame dimensions', async (name, oracle) => {
				using input = new Input({ source: new BufferSource(fixture(name)), formats: [MXF] });
				const track = (await input.getPrimaryVideoTrack())!;
				expect(await track.getDecoderConfig()).toMatchObject({ codedWidth: 64, codedHeight: 48 });
				const sink = new EncodedPacketSink(track);
				let i = 0;
				for await (const packet of sink.packets()) {
					const expected = oracle.packets[i]!;
					expect([packet.sequenceNumber, packet.timestamp, packet.duration, packet.byteLength,
						`SHA256:${hash(packet.data)}`])
						.toEqual([i++, expected.pts / 25, 1 / 25, Number(expected.size), expected.data_hash]);
				}
				expect(i).toBe(oracle.packets.length);
			},
		);
	});

	describe('when delivering cold selections to an external custom decoder', () => {
		it.each([17, 24, 0])('should retain leading Bs and earlier dependencies for picture %i', async (target) => {
			RecordingDecoder.enabled = true;
			RecordingDecoder.packets = [];
			try {
				using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				await sink.getSample(target / 25);
				const start = target === 0 ? 0 : 12;
				const end = target === 0 ? 1 : target === 17 ? 15 : 25;
				expect(RecordingDecoder.packets.map(p => [p.kind, p.ordinal])).toEqual(
					Array.from({ length: end - start + 1 }, (_, i) => {
						const ordinal = start + i;
						return [ordinal === 13 || ordinal === 14 ? 'preroll' : 'decode', ordinal];
					}),
				);
				for (const packet of RecordingDecoder.packets) {
					expect(`SHA256:${packet.hash}`).toBe(manifest.packets[packet.ordinal]!.data_hash);
				}
			} finally {
				RecordingDecoder.enabled = false;
			}
		});

		it('should apply header preroll only at the initial anchor of a cold range', async () => {
			RecordingDecoder.enabled = true;
			RecordingDecoder.packets = [];
			try {
				using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				for await (const sample of sink.samples(24 / 25, 28 / 25)) {
					sample.close();
					throw new Error('The recording decoder must not emit samples');
				}
				expect(RecordingDecoder.packets[0]?.ordinal).toBe(12);
				expect(RecordingDecoder.packets.filter(p => p.kind === 'preroll').map(p => p.ordinal))
					.toEqual([13, 14]);
				expect(RecordingDecoder.packets.filter(p => p.ordinal >= 24).map(p => [p.kind, p.ordinal]))
					.toEqual(Array.from({ length: 12 }, (_, i) => ['decode', i + 24]));
			} finally {
				RecordingDecoder.enabled = false;
			}
		});

		it('should reject a decoder without header-preroll capability rather than silently omit state', async () => {
			NoPrerollDecoder.enabled = true;
			try {
				using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getSample(17 / 25)).rejects.toThrow('does not support header-only preroll');
			} finally {
				NoPrerollDecoder.enabled = false;
			}
		});
	});

	describe('when an external decoder initializes and consumes preroll asynchronously', () => {
		it.each(['mixed timestamps', 'range'] as const)(
			'should serialize preroll and finish flushing before completing %s', async (mode) => {
				const decoder = controlledDecoder();
				const data = fixture();
				const nextPictureRead = deferred();
				const nextPicture = Number(manifest.packets[15]!.pos) + 20;
				using input = new Input({ formats: [MXF], source: new CustomSource({
					getSize: () => data.length, prefetchProfile: 'none', maxCacheSize: 0,
					read: (start, end) => {
						if (start <= nextPicture && end > nextPicture
							&& decoder.events.includes('preroll:13:start')) {
							nextPictureRead.resolve();
						}
						return data.subarray(start, end);
					},
				}) });
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				const samples = mode === 'range'
					? sink.samples(24 / 25, 28 / 25)
					: sink.samplesAtTimestamps([-0.1, 17 / 25, 24 / 25, 24 / 25, 0, 24 / 25]);
				let completed = false;
				const collect = (async () => {
					const results: null[] = [];
					for await (const sample of samples) {
						expect(sample).toBeNull();
						results.push(null);
					}
					completed = true;
					return results;
				})();
				try {
					await decoder.initEntered.promise;
					expect(decoder.events).toEqual(['init:start']);
					decoder.initGate.resolve();
					await decoder.prerollEntered.promise;
					// Let navigation reach the next picture while the decoder still owns the pending preroll.
					await nextPictureRead.promise;
					expect(decoder.events).toEqual(['init:start', 'init:end', 'decode:12', 'preroll:13:start']);
					decoder.prerollGate.resolve();
					await decoder.flushEntered.promise;
					expect(completed).toBe(false);
					const firstBatch = mode === 'range'
						? [...coldLeadingDelivery, 'decode:26', 'decode:27', 'decode:28', 'decode:29',
								'decode:30', 'decode:31', 'decode:32', 'decode:33', 'decode:34', 'decode:35']
						: coldLeadingDelivery;
					expect(decoder.events).toEqual(['init:start', 'init:end', ...firstBatch, 'flush:start']);
					decoder.flushGate.resolve();
					expect(await collect).toEqual(mode === 'range' ? [] : [null, null, null, null, null, null]);
					await decoder.closed.promise;
					expect(decoder.events).toEqual([
						'init:start', 'init:end', ...firstBatch, 'flush:start', 'flush:end',
						...(mode === 'range'
							? []
							: [
									'decode:0', 'decode:1', 'flush:start', 'flush:end',
									...coldLeadingDelivery, 'flush:start', 'flush:end',
								]),
						'close',
					]);
				} finally {
					decoder.disable();
					decoder.initGate.resolve();
					decoder.prerollGate.resolve();
					decoder.flushGate.resolve();
					await samples.return();
					await collect;
					await decoder.closed.promise;
				}
			},
		);

		it.each([
			['timestamps', 'init'], ['range', 'init'], ['timestamps', 'preroll'], ['range', 'preroll'],
			['timestamps', 'preroll rejection'], ['range', 'preroll rejection'],
		] as const)('should propagate asynchronous %s %s errors and close the decoder', async (mode, phase) => {
			const decoder = controlledDecoder(phase);
			using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			const samples = mode === 'range' ? sink.samples(24 / 25) : sink.samplesAtTimestamps([24 / 25]);
			const rejected = expect(samples.next()).rejects.toBe(decoder.error);
			try {
				await decoder.initEntered.promise;
				decoder.initGate.resolve();
				if (phase !== 'init') {
					await decoder.prerollEntered.promise;
					expect(decoder.events).toEqual(['init:start', 'init:end', 'decode:12', 'preroll:13:start']);
				}
				decoder.prerollGate.resolve();
				decoder.flushGate.resolve();
				await rejected;
			} finally {
				decoder.disable();
				decoder.initGate.resolve();
				decoder.prerollGate.resolve();
				decoder.flushGate.resolve();
				await samples.return();
				await decoder.closed.promise;
			}
		});

		it.each([undefined, -0.1])('should deliver the initial range at %s without preroll', async (start) => {
			const decoder = controlledDecoder();
			decoder.initGate.resolve();
			decoder.prerollGate.resolve();
			decoder.flushGate.resolve();
			try {
				using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				for await (const sample of sink.samples(start, 0.12)) {
					sample.close();
					throw new Error('The recording decoder must not emit samples');
				}
				await decoder.closed.promise;
				expect(decoder.events).toEqual([
					'init:start', 'init:end', 'decode:0', 'decode:1', 'decode:2', 'decode:3', 'decode:4',
					'decode:5', 'decode:6', 'decode:7', 'decode:8', 'decode:9', 'decode:10', 'decode:11',
					'decode:12', 'decode:13', 'decode:14', 'decode:15', 'decode:16', 'decode:17', 'decode:18',
					'decode:19', 'decode:20', 'decode:21', 'decode:22', 'decode:23', 'decode:24', 'decode:25',
					'decode:26', 'decode:27', 'decode:28', 'decode:29', 'decode:30', 'decode:31', 'decode:32',
					'decode:33', 'decode:34', 'decode:35', 'flush:start', 'flush:end', 'close',
				]);
			} finally {
				decoder.disable();
			}
		});
	});

	describe('when headers or dependency indexes contradict the supported subset', () => {
		it.each([
			['temporal reference', 'temporal reference disagrees'],
			['field picture', 'requires frame pictures'],
			['repeated field', 'repeated fields are unsupported'],
		] as const)('should reject an invalid %s before returning a leading packet', async (kind, error) => {
			const data = fixture();
			const start = Number(manifest.packets[1]!.pos) + 20;
			const picture = data.indexOf(Buffer.from('00000100', 'hex'), start);
			const extension = data.indexOf(Buffer.from('000001b5', 'hex'), picture + 4) + 4;
			if (kind === 'temporal reference') {
				data[picture + 5] = (data[picture + 5]! & 0x3f) | 0xc0;
			} else if (kind === 'field picture') {
				data[extension + 2] = (data[extension + 2]! & ~3) | 1;
			} else {
				data[extension + 3] = data[extension + 3]! | 2;
			}
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(0)).rejects.toThrow(error);
		});

		it('should reject a dependency that jumps over the preceding GOP', async () => {
			const data = fixture();
			let field = data.indexOf(Buffer.from('060e2b34025301010d01020101100100', 'hex')) + 20;
			while (data.readUInt16BE(field) !== 0x3f0a) {
				field += 4 + data.readUInt16BE(field + 2);
			}
			const entrySize = data.readUInt32BE(field + 8);
			data[field + 12 + 25 * entrySize + 1] = 256 - 25;
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(24 / 25)).rejects.toThrow('dependency skips an intervening GOP');
		});
	});
});
