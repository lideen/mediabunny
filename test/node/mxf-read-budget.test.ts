import { describe, expect, it } from 'vitest';
import { Input, MXF, EncodedPacketSink, CustomSource } from '../../src/index.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

describe('given a ten GB indexed MXF', () => {
	describe('when seeking cold into late essence without source prefetch', () => {
		it.each([false, true])('should bound demux reads independently of file position, AVC %s', async (avc) => {
			const fixture = makeIndexedMxf({ avc });
			// Repeated AVC parameters require one initial access unit for the cold stability check.
			const byteBudget = 2 * 1024 * 1024 + (avc ? fixture.frameSize : 0);
			const counts: number[] = [];
			for (const frame of [8750, 9750]) {
				const decode = avc ? frame + 1 : frame;
				const reads: [number, number][] = [];
				let bytes = 0;
				using input = new Input({ formats: [MXF], source: new CustomSource({
					getSize: () => fixture.size,
					prefetchProfile: 'none',
					read: (start, end) => {
						reads.push([start, end]);
						bytes += end - start;
						if (bytes > byteBudget || reads.length > 48) {
							throw new Error(`Demux read budget exceeded: ${bytes} bytes in ${reads.length} reads`);
						}
						return fixture.read(start, end);
					},
				}) });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				const packet = (await sink.getPacket(frame / 25))!;
				expect([packet.timestamp, packet.duration, packet.sequenceNumber, packet.byteLength])
					.toEqual([frame / 25, 0.04, decode, 1048576]);
				expect(packet.data).toHaveLength(1048576);
				expect(packet.data[avc ? 127 : 39]).toBe(decode % 256);
				const before = [reads.length, bytes];
				const cached = (await sink.getPacket(frame / 25, { metadataOnly: true }))!;
				expect([cached.timestamp, cached.sequenceNumber, cached.byteLength])
					.toEqual([frame / 25, decode, 1048576]);
				expect([reads.length, bytes]).toEqual(before);
				const next = (await sink.getPacket((frame + 10) / 25, { metadataOnly: true }))!;
				expect(next.byteLength).toBe(1048576);
				expect(reads.length - before[0]!).toBeLessThanOrEqual(avc ? 1 : 3);
				expect(bytes - before[1]!).toBeLessThanOrEqual(avc ? 25 : 128);
				counts.push(reads.length);
			}
			expect(Math.abs(counts[1]! - counts[0]!)).toBeLessThanOrEqual(2);
		});
	});
});
