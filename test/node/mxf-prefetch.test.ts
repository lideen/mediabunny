import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { Input } from '../../src/input.js';
import { MXF } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';
import { assert } from '../../src/misc.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

describe('given indexed MXF with small interleaved essence packets over HTTP', () => {
	describe('when reading sequential packets after a cold seek', () => {
		it.each([
			{ avc: false, floor: 32768 }, { avc: true, floor: 32768 },
			{ avc: false, floor: undefined }, { avc: true, floor: undefined },
			{ avc: true, floor: 32768, maxCacheSize: 65536 },
		])('should reuse source prefetch without scanning the file, %j', async ({ avc, floor, maxCacheSize }) => {
			const fixture = makeIndexedMxf({ avc, frameSize: 8192 });
			const ranges: [number, number][] = [];
			const delivered: number[] = [];
			const server = http.createServer((req, res) => {
				const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
				const start = Number(match?.[1]);
				const end = match?.[2] ? Math.min(Number(match[2]) + 1, fixture.size) : fixture.size;
				if (!match || (match[2] && end - start > 8 * 1024 * 1024)) {
					res.writeHead(416).end();
					return;
				}
				ranges.push([start, end]);
				const request = delivered.push(0) - 1;
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${end - 1}/${fixture.size}`,
					'Content-Length': end - start,
				});
				const send = async () => {
					for (let offset = start; offset < end && !res.destroyed; offset += 16384) {
						const bytes = fixture.read(offset, Math.min(offset + 16384, end));
						delivered[request]! += bytes.length;
						res.write(bytes);
						await setTimeout(1);
					}
					res.end();
				};
				void send().catch(() => res.destroy());
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			try {
				const address = server.address();
				assert(address && typeof address !== 'string');
				using input = new Input({ formats: [MXF], source: new UrlSource(
					`http://127.0.0.1:${address.port}/small.mxf`, {
						rangePolicy: floor ? { minimumRequestSize: floor } : undefined, getRetryDelay: () => null,
						maxCacheSize,
					},
				) });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				const metadata = await sink.getPacket(350, { metadataOnly: true });
				expect(metadata!.byteLength).toBe(8192);
				const payload = fixture.offsets[2]! + 108 + (avc ? 751 : 750) * fixture.stride + 52;
				if (floor) {
					expect(ranges.every(([start, end]) => end <= payload + 5 || start >= payload + 8192)).toBe(true);
				}
				let packet = await sink.getPacket(350);
				expect(packet).not.toBeNull();
				expect(ranges.length).toBeLessThan(48);
				expect(delivered.reduce((sum, bytes) => sum + bytes, 0))
					.toBeLessThan(floor ? 256 * 1024 : 2 * 1024 * 1024);
				const before = ranges.length;
				const bytesBefore = delivered.reduce((sum, bytes) => sum + bytes, 0);
				for (let i = 0; i < 100; i++) {
					packet = await sink.getNextPacket(packet!);
					expect(packet!.data).toHaveLength(8192);
					expect(packet!.data[avc ? 127 : 39]).toBe(packet!.sequenceNumber % 256);
				}
				const reads = ranges.slice(before);
				const bytes = delivered.reduce((sum, bytes) => sum + bytes, 0) - bytesBefore;
				console.log('MXF sequential HTTP', { avc, floor, requests: reads.length, bytes });
				expect(reads.length).toBeLessThan(avc && !maxCacheSize ? 150 : 250);
				expect(bytes).toBeLessThan(floor ? 3 * 1024 * 1024 : 12 * 1024 * 1024);
				const beforeRepeat = ranges.length;
				const repeated = await sink.getPacket(packet!.timestamp, { metadataOnly: true });
				expect(repeated!.sequenceNumber).toBe(packet!.sequenceNumber);
				expect(ranges).toHaveLength(beforeRepeat);
				const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
				const boundaryStart = ranges.length;
				const [lastVideo, lastAudio] = await Promise.all([
					sink.getPacket(7999 / 25), audio.getPacket(7999 / 25),
				]);
				expect(lastVideo!.data[avc ? 127 : 39]).toBe((avc ? 7997 : 7999) % 256);
				expect(lastAudio!.data).toHaveLength(5760);
				const partitionEnd = fixture.offsets[2]!;
				const boundaryReads = ranges.slice(boundaryStart).filter(([start]) =>
					start >= fixture.offsets[1]! && start < partitionEnd);
				expect(boundaryReads.length).toBeGreaterThan(0);
				if (floor) expect(boundaryReads.every(([, end]) => end <= partitionEnd)).toBe(true);
				input.dispose();
				const beforeDisposed = ranges.length;
				await expect(sink.getNextPacket(lastVideo!)).rejects.toThrow(/disposed/i);
				expect(ranges).toHaveLength(beforeDisposed);
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			}
		});
	});
});
