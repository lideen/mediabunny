import { describe, expect, it } from 'vitest';
import {
	CustomPathedSource, CustomSource, EncodedPacket, EncodedPacketSink, Input, MXF, VideoSampleSink,
} from '../../src/index.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';
import { makeColdInput } from './smooth-cold-fixture.js';

const makeFile = () => makeIndexedMxf({ editRate: [24, 1],
	htj2k: { data: new Uint8Array(1024 * 1024), bits: 16 } });

describe('given bounded packet-range prefetching', () => {
	it('should reject invalid or unowned packets even for empty ranges without fetching their payload', async () => {
		const file = makeFile();
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read }) });
		using other = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read }) });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);
		const packet = (await sink.getFirstPacket({ metadataOnly: true }))!;
		const foreign = (await new EncodedPacketSink((await other.getPrimaryVideoTrack())!)
			.getFirstPacket({ metadataOnly: true }))!;
		const before = file.reads.length;
		for (const invalid of [packet.clone(), foreign, new EncodedPacket(new Uint8Array(), 'key', 0, 1 / 24)]) {
			await expect(sink.prefetchPacketRange(invalid, 0, 0)).rejects.toThrow();
		}
		for (const [start, end] of [[-1, 0], [2, 1], [0, packet.byteLength + 1], [0, NaN], [0.5, 1]]) {
			await expect(sink.prefetchPacketRange(packet, start!, end!)).rejects.toThrow('range');
		}
		const reason = new Error('retired');
		await expect(sink.prefetchPacketRange(packet, 0, 0,
			{ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
		await expect(sink.prefetchPacketRange(packet, 0, 0,
			{ signal: {} as AbortSignal })).rejects.toThrow('AbortSignal');
		await expect(new EncodedPacketSink(track).prefetchPacketRange(packet, 0, 0)).resolves.toBeUndefined();
		const size = packet.byteLength;
		for (const invalidSize of [-1, size + 1, size - 1]) {
			Reflect.set(packet, 'byteLength', invalidSize);
			await expect(sink.prefetchPacketRange(packet, 0, 0)).rejects.toThrow();
		}
		Reflect.set(packet, 'byteLength', size);
		expect(file.reads.length).toBe(before);
		input.dispose();
		await expect(sink.prefetchPacketRange(packet, 0, 0)).rejects.toThrow();
	});

	it('should reject an unsupported track without a complete-packet fallback', async () => {
		const file = makeIndexedMxf();
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read }) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const packet = (await sink.getFirstPacket({ metadataOnly: true }))!;
		const before = file.reads.length;
		await expect(sink.prefetchPacketRange(packet, 0, 0)).rejects.toThrow();
		await expect(sink.prefetchPacketRange(packet, 0, 1024)).rejects.toThrow();
		expect(file.reads.length).toBe(before);
		const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
		const audioPacket = (await audio.getFirstPacket({ metadataOnly: true }))!;
		const audioBefore = file.reads.length;
		await expect(audio.prefetchPacketRange(audioPacket, 0, 0)).rejects.toThrow('does not support');
		expect(file.reads.length).toBe(audioBefore);
	});

	describe.each(['direct', 'slice', 'pathed'] as const)('when using a %s source', (wrapper) => {
		it.skipIf(!process.env['HTJ2K_EVIDENCE'])('should share a warm read with real decoding', async () => {
			const fixture = await makeColdInput(process.env['HTJ2K_EVIDENCE']!);
			fixture.input.dispose();
			const file = fixture.file;
			let hold = false;
			let release!: () => void;
			let admitted!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				admitted = resolve;
			});
			const start = file.offsets[0]! + file.regions[1]!.data.length + 10 * file.stride;
			const source = new CustomSource({ getSize: () => file.size, read: async (offset, end) => {
				if (hold && offset >= start && offset < start + file.stride) {
					admitted();
					await gate;
				}
				return file.read(offset, end);
			} });
			const wrapped = wrapper === 'slice'
				? source.slice(0, file.size)
				: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', async () => source) : source;
			using input = new Input({ formats: [MXF], source: wrapped });
			const track = (await input.getPrimaryVideoTrack())!;
			const packets = new EncodedPacketSink(track);
			const packet = (await packets.getPacket(10.5 / 24, { metadataOnly: true }))!;
			const before = file.reads.length;
			hold = true;
			const warming = packets.prefetchPacketRange(packet, 0, 65536);
			void warming.catch(() => {});
			await started;
			const iterator = new VideoSampleSink(track, { reducedResolution: { width: 120, height: 68 } })
				.samplesAtTimestamps([10.5 / 24]);
			try {
				let delivered = false;
				const next = iterator.next().then((result) => {
					delivered = true;
					return result;
				});
				void next.catch(() => {});
				await new Promise(resolve => setTimeout(resolve, 10));
				expect(delivered).toBe(false);
				release();
				const sample = (await next).value!;
				await warming;
				expect([sample.timestamp, sample.codedWidth, sample.codedHeight]).toEqual([10 / 24, 120, 68]);
				sample.close();
				expect(file.reads.slice(before).filter(([offset]) => offset >= start && offset < start + file.stride))
					.toHaveLength(1);
			} finally {
				release();
				await iterator.return();
			}
		});

		it('should detach cancellation while sharing a finite warm read and preserving Input reuse', async () => {
			const file = makeFile();
			let hold = false;
			let release!: () => void;
			let admitted!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				admitted = resolve;
			});
			const source = new CustomSource({ getSize: () => file.size, read: async (start, end) => {
				if (hold) {
					admitted();
					await gate;
				}
				return file.read(start, end);
			} });
			const wrapped = wrapper === 'slice'
				? source.slice(0, file.size)
				: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', async () => source) : source;
			using input = new Input({ formats: [MXF], source: wrapped });
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new EncodedPacketSink(track);
			const packet = (await sink.getPacket(1, { metadataOnly: true }))!;
			const before = file.reads.length;
			hold = true;
			const abort = new AbortController();
			const canceled = sink.prefetchPacketRange(packet, 0, 16384, { signal: abort.signal })
				.catch((error: unknown) => error);
			try {
				await started;
				const shared = new EncodedPacketSink(track).prefetchPacketRange(packet, 0, 16384);
				void shared.catch(() => {});
				const reason = new Error('retired');
				abort.abort(reason);
				expect(await canceled).toBe(reason);
				release();
				await shared;
				const reads = file.reads.slice(before);
				expect(reads.length).toBe(1);
				expect(reads[0]![1] - reads[0]![0]).toBeLessThanOrEqual(16384);
				await sink.prefetchPacketRange(packet, 0, 16384);
				expect(file.reads.length).toBe(before + 1);
			} finally { release(); }
		});
	});
});
