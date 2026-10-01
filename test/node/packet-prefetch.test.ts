import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import {
	CustomPathedSource, CustomSource, EncodedPacket, EncodedPacketSink, Input, MXF, VideoSampleSink,
} from '../../src/index.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';
import { makeMxf } from './mxf-fixture.js';

const makeFile = () => makeIndexedMxf({ editRate: [24, 1], videoOnly: true, htj2k: {
	data: readFileSync(new URL('../public/htj2k-rpcl-193x131-16.j2c', import.meta.url)),
	bits: 16, width: 193, height: 131,
} });

describe('given bounded packet-range prefetching', () => {
	describe('when a request does not identify an owned supported packet range', () => {
		it('should reject unindexed HTJ2K rather than scan or fetch the complete packet', async () => {
			const data = readFileSync(new URL('../public/htj2k-rpcl-193x131-16.j2c', import.meta.url));
			const file = makeMxf({ videoOnly: true, htj2k: { data, bits: 16, width: 193, height: 131 } }).data;
			const reads: [number, number][] = [];
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.length,
				read: (start, end) => {
					reads.push([start, end]);
					return file.slice(start, end);
				} }) });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const packet = (await sink.getFirstPacket({ metadataOnly: true }))!;
			const before = reads.length;
			for (const end of [0, 16384]) {
				await expect(sink.prefetchPacketRange(packet, 0, end)).rejects.toThrow('indexed packet');
			}
			expect(reads.length).toBe(before);
		});

		it('should reject without fetching payload, including empty ranges', async () => {
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
			await expect(sink.prefetchPacketRange(packet, 0, 0, { signal: AbortSignal.abort(reason) }))
				.rejects.toBe(reason);
			await expect(sink.prefetchPacketRange(packet, 0, 0, { signal: {} as AbortSignal }))
				.rejects.toThrow('AbortSignal');
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

		it('should reject unsupported video and audio without a complete-packet fallback', async () => {
			const file = makeIndexedMxf();
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => file.size, read: file.read }) });
			for (const track of [(await input.getPrimaryVideoTrack())!, (await input.getPrimaryAudioTrack())!]) {
				const sink = new EncodedPacketSink(track);
				const packet = (await sink.getFirstPacket({ metadataOnly: true }))!;
				const before = file.reads.length;
				await expect(sink.prefetchPacketRange(packet, 0, 0)).rejects.toThrow();
				await expect(sink.prefetchPacketRange(packet, 0, 1024)).rejects.toThrow();
				expect(file.reads.length).toBe(before);
			}
		});
	});

	describe.each(['direct', 'slice', 'pathed'] as const)('when using a %s source', (wrapper) => {
		it('should detach cancellation, share a warm range with real decoding, and preserve input reuse', async () => {
			registerHtj2kDecoder();
			const file = makeFile();
			let hold = false;
			let release!: () => void;
			let notify!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				notify = resolve;
			});
			const source = new CustomSource({ getSize: () => file.size, prefetchProfile: 'none',
				read: async (start, end) => {
					if (hold) {
						notify();
						await gate;
					}
					return file.read(start, end);
				} });
			const wrapped = wrapper === 'slice'
				? source.slice(0, file.size)
				: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', () => source) : source;
			using input = new Input({ formats: [MXF], source: wrapped });
			const track = (await input.getPrimaryVideoTrack())!;
			await track.getDecoderConfig();
			const sink = new EncodedPacketSink(track);
			const packet = (await sink.getPacket(10.5 / 24, { metadataOnly: true }))!;
			const before = file.reads.length;
			hold = true;
			const abort = new AbortController();
			const canceled = sink.prefetchPacketRange(packet, 0, 16384, { signal: abort.signal })
				.catch((error: unknown) => error);
			const iterator = new VideoSampleSink(track, { reducedResolution: { width: 25, height: 17 } })
				.samplesAtTimestamps([10.5 / 24]);
			try {
				await started;
				const shared = sink.prefetchPacketRange(packet, 0, 16384);
				let delivered = false;
				const pending = iterator.next().then((result) => {
					delivered = true;
					return result;
				});
				await setImmediate();
				expect(delivered).toBe(false);
				const reason = new Error('retired warm demand');
				abort.abort(reason);
				expect(await canceled).toBe(reason);
				hold = false;
				release();
				await shared;
				using sample = (await pending).value!;
				expect([sample.timestamp, sample.codedWidth, sample.codedHeight]).toEqual([10 / 24, 25, 17]);
				expect(file.reads.slice(before)).toHaveLength(1);
				expect(file.reads[before]![1] - file.reads[before]![0]).toBeLessThanOrEqual(16384);
				await sink.prefetchPacketRange(packet, 0, 16384);
				expect(file.reads.length).toBe(before + 1);
			} finally {
				release();
				await iterator.return();
			}
		});
	});
});
