import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { Input } from '../../src/input.js';
import { MXF } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';
import { assert } from '../../src/misc.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

describe('given a ten GB indexed MXF served over HTTP', () => {
	describe('when seeking cold into late essence with bounded ranges', () => {
		it.each([16384, 32768])('should bound traffic and reuse cached metadata with a %i floor', async (floor) => {
			const fixture = makeIndexedMxf();
			const counts: number[] = [];
			for (const frame of [8750, 9750]) {
				const ranges: string[] = [];
				let writtenBytes = 0;
				const responses: Promise<void>[] = [];
				const server = http.createServer((req, res) => {
					const range = req.headers.range ?? '';
					ranges.push(range);
					const match = /^bytes=(\d+)-(\d+)$/.exec(range);
					const start = Number(match?.[1]);
					const end = Math.min(Number(match?.[2]), fixture.size - 1);
					// Reject scanning regressions before allocating bytes for the logical file.
					if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
						|| start > end || end - start + 1 > 2 * 1024 * 1024 || ranges.length > 48) {
						res.writeHead(416);
						res.end();
						return;
					}
					const bytes = fixture.read(start, end + 1);
					res.writeHead(206, {
						'Content-Range': `bytes ${start}-${end}/${fixture.size}`,
						'Content-Length': bytes.length,
					});
					writtenBytes += bytes.length;
					responses.push(new Promise<void>(resolve => res.on('finish', resolve)));
					res.end(bytes);
				});
				await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
				try {
					const address = server.address();
					assert(address && typeof address !== 'string');
					using input = new Input({
						formats: [MXF],
						source: new UrlSource(`http://127.0.0.1:${address.port}/indexed.mxf`, {
							rangePolicy: { minimumRequestSize: floor },
							getRetryDelay: () => null,
						}),
					});
					const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
					const packet = await sink.getPacket(frame / 25);
					expect(packet).not.toBeNull();
					expect([packet!.timestamp, packet!.duration, packet!.sequenceNumber, packet!.byteLength])
						.toEqual([frame / 25, 0.04, frame, 1048576]);
					expect(packet!.data).toHaveLength(1048576);
					expect(packet!.data[39]).toBe(frame % 256);
					const requestsBeforeRepeat = ranges.length;
					const bytesBeforeRepeat = writtenBytes;
					const cached = await sink.getPacket(frame / 25, { metadataOnly: true });
					expect([cached!.timestamp, cached!.sequenceNumber, cached!.byteLength])
						.toEqual([frame / 25, frame, 1048576]);
					expect(ranges).toHaveLength(requestsBeforeRepeat);
					expect(writtenBytes).toBe(bytesBeforeRepeat);
					await Promise.all(responses);
					expect(responses).toHaveLength(ranges.length);
					expect(ranges.every(range => /^bytes=\d+-\d+$/.test(range))).toBe(true);
					expect(ranges.length).toBeLessThanOrEqual(48);
					expect(writtenBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
					counts.push(ranges.length);
					console.log('MXF HTTP cold seek', { floor, frame, requests: ranges.length, writtenBytes });
				} finally {
					server.closeAllConnections();
					await new Promise<void>((resolve, reject) => {
						server.close(error => error ? reject(error) : resolve());
					});
				}
			}
			// Index search paths can differ slightly, but another thousand frames must not add a scan.
			expect(Math.abs(counts[1]! - counts[0]!)).toBeLessThanOrEqual(2);
		});
	});
});
