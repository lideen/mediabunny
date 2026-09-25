import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
	CustomPathedSource, CustomSource, EncodedPacketSink, Input, MXF, UrlSource, VideoSampleSink,
} from '../../src/index.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';
import { makeColdInput } from './smooth-cold-fixture.js';

const makeFile = (videoOnly = true, size = 128 * 1024) => makeIndexedMxf({ videoOnly, editRate: [24, 1],
	htj2k: { data: Uint8Array.from({ length: size }, (_, i) => i % 251), bits: 16 } });

describe('given a metadata-only container-window hint', () => {
	it('should validate hints before reading, including for layouts that ignore valid hints', async () => {
		const file = makeFile(false);
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read }) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const before = file.reads.length;
		for (const prefetchBytes of [-1, 0.5, NaN, Infinity, 65537, Number.MAX_SAFE_INTEGER]) {
			await expect(sink.getPacket(10 / 24, { metadataOnly: true, prefetchBytes }))
				.rejects.toThrow('prefetchBytes');
		}
		await expect(sink.getPacket(10 / 24, { prefetchBytes: 1 })).rejects.toThrow('metadataOnly');
		expect(file.reads.length).toBe(before);
		const packet = (await sink.getPacket(10 / 24, { metadataOnly: true, prefetchBytes: 65536 }))!;
		expect(packet.isMetadataOnly).toBe(true);
		const first = file.offsets[0]! + file.regions[1]!.data.length + 10 * file.stride;
		// Default CustomSource workers may bridge gaps between ordinary candidate-header requests.
		const candidateReads = file.reads.filter(([start]) => start >= first && start < first + file.stride);
		expect(candidateReads.some(([start, end]) => end - start > 25)).toBe(true);
		expect(candidateReads.every(([, end]) => end <= first + 32 + 25)).toBe(true);
		await expect(sink.getPacket(10 / 24, { prefetchBytes: 0 })).resolves.toHaveProperty('isMetadataOnly', false);
	});

	it.each([0, 1, 25, 16409, 65536])('should keep the default header or read exactly %i total bytes', async (hint) => {
		const file = makeFile();
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read }) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const packet = (await sink.getPacket(10.5 / 24, { metadataOnly: true, prefetchBytes: hint }))!;
		const start = file.offsets[0]! + file.regions[1]!.data.length + 10 * file.stride;
		expect(file.reads.filter(([offset]) => offset >= start && offset < start + file.stride))
			.toEqual([[start, start + Math.max(25, hint)]]);
		expect([packet.timestamp, packet.duration, packet.sequenceNumber, packet.byteLength, packet.data.length])
			.toEqual([10 / 24, 1 / 24, 10, file.frameSize, 0]);
		const before = file.reads.length;
		await sink.getPacket(10.5 / 24, { metadataOnly: true, prefetchBytes: 65536 });
		expect(file.reads.length).toBe(before); // Cached locations do not promise a second prefix read.
		const complete = (await sink.getPacket(10.5 / 24))!;
		expect(complete.data).toEqual(Uint8Array.from({ length: file.frameSize }, (_, i) => i % 251));
	});

	it.each([3998, 9999])('should clamp a prefix to frame %i or its containing body', async (frame) => {
		const file = makeFile(true, 80);
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read }) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const packet = (await sink.getPacket((frame + 0.5) / 24, { metadataOnly: true, prefetchBytes: 65536 }))!;
		const partition = Math.floor(frame / 4000);
		const start = file.offsets[partition]! + file.regions[partition + 1]!.data.length
			+ (frame % 4000) * file.stride;
		expect(file.reads).toContainEqual([start, start + 100]);
		expect(packet.byteLength).toBe(80);
	});

	it('should preserve packet bounds when CustomSource coalesces a 100-byte window with an earlier gap', async () => {
		const file = makeFile(true, 80);
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read }) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const packet = (await sink.getPacket(100.5 / 24, { metadataOnly: true, prefetchBytes: 65536 }))!;
		const body = file.offsets[0]! + file.regions[1]!.data.length;
		const start = body + 100 * file.stride;
		const physical = file.reads.find(([, end]) => end === start + 100)!;
		expect(physical).toEqual([body + 25, start + 100]);
		expect(physical[1] - physical[0]).toBe(10075);
		expect([packet.sequenceNumber, packet.timestamp, packet.byteLength, packet.data.length])
			.toEqual([100, 100 / 24, 80, 0]);
		expect((await sink.getPacket(100.5 / 24))!.data).toEqual(Uint8Array.from({ length: 80 }, (_, i) => i % 251));
	});

	it.each([1000, 3998, 9999])('should send an exact clamped HTTP Range at frame %i', async (frame) => {
		const file = makeFile(true, 80);
		const ranges: [number, number][] = [];
		const server = createServer((request, response) => {
			const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range!)!;
			const start = Number(match[1]);
			const end = Number(match[2]) + 1;
			ranges.push([start, end]);
			response.writeHead(206, { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` });
			response.end(file.read(start, end));
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing local server address');
		try {
			const url = `http://127.0.0.1:${address.port}/prefix.mxf`;
			using input = new Input({ formats: [MXF], source: new UrlSource(url, {
				rangePolicy: { minimumRequestSize: 32768 },
			}) });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await sink.getPacket((frame + 0.5) / 24, { metadataOnly: true, prefetchBytes: 65536 });
			const partition = Math.floor(frame / 4000);
			const start = file.offsets[partition]! + file.regions[partition + 1]!.data.length
				+ (frame % 4000) * file.stride;
			expect(ranges.filter(([offset]) => offset >= start && offset < start + file.stride))
				.toEqual([[start, start + 100]]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	});

	it.each(['BER', 'key', 'body'] as const)('should reject malformed %s before publication', async (corruption) => {
		const file = makeFile();
		const frame = corruption === 'body' ? 3999 : 10;
		const start = file.offsets[0]! + file.regions[1]!.data.length + frame * file.stride;
		using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
			read: (offset, end) => {
				const bytes = file.read(offset, end);
				if (offset === start) {
					if (corruption === 'BER') bytes[16] = 0x80;
					else if (corruption === 'key') bytes[15] = 2;
					else bytes.set([0xff, 0xff, 0xff], 17);
				}
				return bytes;
			} }) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		await expect(sink.getPacket((frame + 0.5) / 24, { metadataOnly: true, prefetchBytes: 65536 }))
			.rejects.toThrow(corruption === 'BER' ? 'BER' : corruption === 'key' ? 'essence key' : 'partition');
	});

	describe.each(['direct', 'slice', 'pathed'] as const)('when using a %s source', (wrapper) => {
		it.skipIf(!process.env['HTJ2K_EVIDENCE'])('should decode from one cold combined range', async () => {
			const fixture = await makeColdInput(process.env['HTJ2K_EVIDENCE']!);
			fixture.input.dispose();
			const file = fixture.file;
			const source = new CustomSource({ getSize: () => file.size, read: file.read });
			const wrapped = wrapper === 'slice'
				? source.slice(0, file.size)
				: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', async () => source) : source;
			using input = new Input({ formats: [MXF], source: wrapped });
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new EncodedPacketSink(track);
			await sink.getPacket(10.5 / 24, { metadataOnly: true, prefetchBytes: 65536 });
			const sample = (await new VideoSampleSink(track, { reducedResolution: { width: 120, height: 68 } })
				.getSample(10.5 / 24))!;
			expect([sample.timestamp, sample.codedWidth, sample.codedHeight]).toEqual([10 / 24, 120, 68]);
			sample.close();
			const start = file.offsets[0]! + file.regions[1]!.data.length + 10 * file.stride;
			expect(file.reads.filter(([offset]) => offset >= start && offset < start + file.stride))
				.toEqual([[start, start + 65536]]);
		});

		it('should detach cancellation, share its range and avoid follow-on reads', async () => {
			const file = makeFile();
			const start = file.offsets[0]! + file.regions[1]!.data.length + 10 * file.stride;
			let release!: () => void;
			let notify!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				notify = resolve;
			});
			const source = new CustomSource({ getSize: () => file.size, read: async (offset, end) => {
				if (offset === start) {
					notify();
					await gate;
				}
				return file.read(offset, end);
			} });
			const wrapped = wrapper === 'slice'
				? source.slice(0, file.size)
				: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', async () => source) : source;
			using input = new Input({ formats: [MXF], source: wrapped });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const abort = new AbortController();
			const canceled = sink.getPacket(10.5 / 24,
				{ metadataOnly: true, prefetchBytes: 65536, signal: abort.signal })
				.catch((error: unknown) => error);
			try {
				await started;
				const shared = sink.getPacket(10.5 / 24, { metadataOnly: true, prefetchBytes: 65536 });
				const reason = new Error('retired prefix');
				abort.abort(reason);
				expect(await canceled).toBe(reason);
				release();
				expect((await shared)!.sequenceNumber).toBe(10);
				await sink.getPacket(10.5 / 24, { metadataOnly: true, prefetchBytes: 65536 });
				expect(file.reads.filter(([offset]) => offset >= start && offset < start + file.stride))
					.toEqual([[start, start + 65536]]);
			} finally { release(); }
		});
	});
});
