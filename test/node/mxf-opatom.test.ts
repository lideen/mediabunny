import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { MXF } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, CustomSource, UrlSource } from '../../src/source.js';
import { makeOpAtomMxf } from './mxf-opatom-fixture.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { assert } from '../../src/misc.js';

describe('given a single-file Doremi-layout OPAtom AVC stream', () => {
	describe('when adjacent index segments share a body partition without terminal sentinel entries', () => {
		it.each([false, true])('should traverse the index split with standard AVC %s', async (standard) => {
			const fixture = makeOpAtomMxf({ standard, splitIndex: true });
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const order = standard ? [0, 3, 1, 2, 4, 7, 5, 6, 8, 11, 9, 10] : [0, 4, 1, 2, 3, 8, 5, 6, 7, 11, 9, 10];
			for (const metadataOnly of [true, false]) {
				let packet = await sink.getFirstPacket({ metadataOnly });
				for (let i = 0; i < 12; i++) {
					expect([packet!.sequenceNumber, packet!.timestamp, packet!.duration, packet!.type])
						.toEqual([i, order[i]! / 24, 1 / 24, (standard ? i % 4 === 0 : i === 0) ? 'key' : 'delta']);
					if (!metadataOnly) expect(packet!.data).toEqual(fixture.payloads[i]);
					packet = await sink.getNextPacket(packet!, { metadataOnly });
				}
				expect(packet).toBeNull();
			}
			const key = (await sink.getKeyPacket(order[5]! / 24))!;
			expect(key.sequenceNumber).toBe(standard ? 4 : 0);
		});

		it.each([false, true])('should reject missing next-segment coverage with standard AVC %s', async (standard) => {
			const fixture = makeOpAtomMxf({ standard, splitIndex: true, missingNextEntry: true });
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket((standard ? 7 : 8) / 24, { metadataOnly: true }))
				.rejects.toThrow(/missing AVC temporal index entry/);
		});

		it.each([false, true])('should still reject a gap at the split with standard AVC %s', async (standard) => {
			const fixture = makeOpAtomMxf({ standard, splitIndex: true });
			fixture.data[fixture.bodyStart + 5 * 148 + 19] = 127;
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket((standard ? 7 : 8) / 24, { metadataOnly: true }))
				.rejects.toThrow(/one essence element per edit unit/);
		});
	});

	describe('when retrieving packets and seeking across non-IDR recovery pictures', () => {
		it.each([[24, 1], [24000, 1001]] as const)('should preserve payloads and PTS at %i/%i', async (n, d) => {
			const fixture = makeOpAtomMxf({ rate: [n, d] });
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await input.getAudioTracks()).toEqual([]);
			expect(await track.getDecoderConfig())
				.toMatchObject({ codec: 'avc1.4d4029', codedWidth: 1280, codedHeight: 720 });
			expect(await track.computeDuration()).toBe(12 * d / n);
			const sink = new EncodedPacketSink(track);
			let packet = await sink.getFirstPacket();
			const order = [0, 4, 1, 2, 3, 8, 5, 6, 7, 11, 9, 10];
			for (let i = 0; i < 12; i++) {
				expect(packet!.data).toEqual(fixture.payloads[i]);
				expect([packet!.sequenceNumber, packet!.timestamp, packet!.type, packet!.duration])
					.toEqual([i, order[i]! * d / n, i === 0 ? 'key' : 'delta', d / n]);
				const metadata = (await sink.getPacket(order[i]! * d / n, { metadataOnly: true }))!;
				expect([metadata.sequenceNumber, metadata.timestamp, metadata.type, metadata.byteLength])
					.toEqual([i, packet!.timestamp, packet!.type, packet!.byteLength]);
				packet = await sink.getNextPacket(packet!);
			}
			expect(packet).toBeNull();
			for (const time of [0, 5 * d / n, 11 * d / n, Infinity]) {
				expect((await sink.getKeyPacket(time))!.sequenceNumber).toBe(0);
			}
			const first = (await sink.getFirstPacket())!;
			expect(await sink.getNextKeyPacket(first)).toBeNull();
			expect(await sink.getKeyPacket(-1)).toBeNull();
			using other = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const otherSink = new EncodedPacketSink((await other.getPrimaryVideoTrack())!);
			await expect(otherSink.getNextPacket(first)).rejects.toThrow(/does not belong/);
			await expect(otherSink.getNextKeyPacket(first)).rejects.toThrow(/does not belong/);
		});
	});

	describe('when the supported layout or index contract is violated', () => {
		it('should retain the standard closed-GOP AVC key contract under OPAtom', async () => {
			const fixture = makeOpAtomMxf({ standard: true });
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const packet = (await sink.getPacket(5 / 24))!;
			expect([packet.sequenceNumber, packet.timestamp, packet.type]).toEqual([6, 5 / 24, 'delta']);
			const key = (await sink.getKeyPacket(5 / 24, { verifyKeyPackets: true }))!;
			expect([key.sequenceNumber, key.timestamp, key.type]).toEqual([4, 4 / 24, 'key']);
			expect((await sink.getNextKeyPacket(key))!.sequenceNumber).toBe(8);
		});

		it('should reject an initial access point whose payload is not IDR', async () => {
			const fixture = makeOpAtomMxf();
			const bytes = Buffer.from(fixture.data.buffer);
			const offset = bytes.indexOf(Buffer.from('000000016588', 'hex'), fixture.bodyStart);
			bytes[offset + 4] = 0x41;
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(10 / 24)).rejects.toThrow(/must contain IDR/);
		});

		it('should reject unindexed bytes between video elements', async () => {
			const fixture = makeOpAtomMxf();
			// Shorten the declared payload without changing the next indexed edit unit's position.
			fixture.data[fixture.bodyStart + 19] = 127;
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getFirstPacket({ metadataOnly: true })).rejects.toThrow(/one essence element/);
		});
		it.each([
			['multiple essence tracks', { audio: true }],
			['external package', { externalPackage: true }],
			['legacy descriptor in OP1a', { op1a: true }],
		] as const)('should reject %s', async (_, options) => {
			using input = new Input({ source: new BufferSource(makeOpAtomMxf(options).data), formats: [MXF] });
			await expect(input.getPrimaryVideoTrack()).rejects.toThrow(/Unsupported or invalid MXF/);
		});

		it('should reject parameter changes at non-IDR recovery pictures', async () => {
			using input = new Input({ source: new BufferSource(makeOpAtomMxf({ changedParameters: true }).data),
				formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(8 / 24)).rejects.toThrow(/stable parameter sets/);
		});

		it.each([
			['positive distance out of range', 1, 1, 128, /distance out of range/],
			['distance pointing past a recovery picture', 6, 1, 6, /distance disagrees/],
			['invalid picture flags', 2, 2, 0x01, /picture flags/],
			['overflow flag', 2, 2, 0x3b, /overflow/],
			['non-bijective temporal map', 0, 0, 1, /unique inverse/],
		] as const)('should reject %s', async (_, row, field, value, error) => {
			const fixture = makeOpAtomMxf();
			fixture.entries[row * 11 + field] = value;
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const traverse = async () => {
				let packet = await sink.getFirstPacket({ metadataOnly: true });
				while (packet) packet = await sink.getNextPacket(packet, { metadataOnly: true });
			};
			await expect(traverse()).rejects.toThrow(error);
		});

		it.each([
			['clip wrapping', '060e2b34040101020d01030102106001', '060e2b34040101020d01030102106002'],
			['unrecognized Codec label', '060e2b340401010a0401020201322001', '060e2b340401010a0401020201324001'],
		] as const)('should reject %s rather than guessing from the payload', async (_, from, to) => {
			const fixture = makeOpAtomMxf();
			const bytes = Buffer.from(fixture.data.buffer);
			const offset = bytes.indexOf(Buffer.from(from, 'hex'));
			bytes.set(Buffer.from(to, 'hex'), offset);
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			await expect(input.getPrimaryVideoTrack()).rejects.toThrow(/Unsupported or invalid MXF/);
		});
	});

	describe('when seeking metadata in a large single essence track', () => {
		it('should read index and KLV headers without fetching intervening essence', async () => {
			const fixture = makeOpAtomMxf({ frameSize: 1024 * 1024 });
			const reads: [number, number][] = [];
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => fixture.data.length,
				read: (start, end) => {
					reads.push([start, end]);
					return fixture.data.slice(start, end);
				} }) });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const packet = (await sink.getPacket(10 / 24, { metadataOnly: true }))!;
			expect([packet.sequenceNumber, packet.type, packet.byteLength]).toEqual([11, 'delta', 1024 * 1024]);
			expect((await sink.getKeyPacket(10 / 24, { metadataOnly: true }))!.sequenceNumber).toBe(0);
			expect(await sink.getNextKeyPacket(packet, { metadataOnly: true })).toBeNull();
			for (let i = 0; i < 12; i++) {
				const start = fixture.bodyStart + i * (1024 * 1024 + 20) + 20;
				expect(reads.some(([a, b]) => a < start + 1024 * 1024 && b > start)).toBe(false);
			}
			expect(reads.reduce((sum, [a, b]) => sum + b - a, 0)).toBeLessThan(16000);
			expect(reads.length).toBeLessThan(40);
		});

		it('should bound cold HTTP metadata traffic and fetch only the requested restart payload', async () => {
			const fixture = makeOpAtomMxf({ frameSize: 1024 * 1024 });
			const ranges: string[] = [];
			let writtenBytes = 0;
			const server = http.createServer((req, res) => {
				const range = req.headers.range ?? '';
				ranges.push(range);
				const match = /^bytes=(\d+)-(\d+)$/.exec(range);
				if (!match || ranges.length > 20) {
					res.writeHead(416).end();
					return;
				}
				const start = Number(match[1]);
				const end = Math.min(Number(match[2]), fixture.data.length - 1);
				const data = fixture.data.subarray(start, end + 1);
				writtenBytes += data.length;
				res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fixture.data.length}`,
					'Content-Length': data.length }).end(data);
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			try {
				const address = server.address();
				assert(address && typeof address !== 'string');
				using input = new Input({ formats: [MXF],
					source: new UrlSource(`http://127.0.0.1:${address.port}/opatom.mxf`, {
						rangePolicy: { minimumRequestSize: 32768 }, getRetryDelay: () => null,
					}) });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				const late = (await sink.getPacket(10 / 24, { metadataOnly: true }))!;
				expect(late.sequenceNumber).toBe(11);
				expect(writtenBytes).toBeLessThan(100000);
				const key = (await sink.getKeyPacket(10 / 24))!;
				expect([key.sequenceNumber, key.timestamp, key.type]).toEqual([0, 0, 'key']);
				expect(key.data).toEqual(fixture.payloads[0]);
				const before = [ranges.length, writtenBytes];
				expect((await sink.getKeyPacket(10 / 24))!.sequenceNumber).toBe(0);
				expect(await sink.getNextKeyPacket(key)).toBeNull();
				expect([ranges.length, writtenBytes]).toEqual(before);
				expect(writtenBytes).toBeLessThan(2 * 1024 * 1024);
				expect(ranges.length).toBeLessThanOrEqual(12);
				console.log('OPAtom cold HTTP metadata and initial IDR', { requests: ranges.length, writtenBytes });
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			}
		});
	});
});

describe('given the untouched opt-in Doremi OPAtom files', () => {
	describe('when traversing all access units through the public packet API', () => {
		for (const [env, numerator, denominator, hash] of [
			['MXF_OPATOM_FIXTURE', 24, 1, '6c56096b256549aec25e6c3b1435bf3693c0dfefb1fee668b81a166387a585e2'],
			['MXF_OPATOM_FRACTIONAL_FIXTURE', 24000, 1001,
				'15d7546b55fcd0fe6c42541bbe2383716825d2c49c1774083c4b8de9e0a6958c'],
		] as const) {
			it.skipIf(!process.env[env])(`should match FFmpeg decoded PTS and packet hashes for ${env}`, async () => {
				const path = process.env[env]!;
				const data = await readFile(path);
				expect(createHash('sha256').update(data).digest('hex')).toBe(hash);
				const frames = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
					'-show_frames', '-show_entries', 'frame=pkt_pos,best_effort_timestamp', '-of', 'json', path],
				{ encoding: 'utf8' })) as { frames: { pkt_pos: string; best_effort_timestamp: number }[] };
				const packets = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
					'-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pos,data_hash',
					'-of', 'json', path],
				{ encoding: 'utf8' })) as { packets: { pos: string; data_hash: string }[] };
				const presentation = new Map(frames.frames.map(frame => [frame.pkt_pos, frame.best_effort_timestamp]));
				expect(frames.frames).toHaveLength(240);
				expect(packets.packets).toHaveLength(240);
				using input = new Input({ source: new BufferSource(data), formats: [MXF] });
				const track = (await input.getPrimaryVideoTrack())!;
				expect(await track.getDecoderConfig())
					.toMatchObject({ codec: 'avc1.4d4029', codedWidth: 1920, codedHeight: 1080 });
				expect(await track.computeDuration()).toBe(240 * denominator / numerator);
				expect(await input.getAudioTracks()).toEqual([]);
				const sink = new EncodedPacketSink(track);
				let packet = await sink.getFirstPacket();
				for (let i = 0; i < 240; i++) {
					const oracle = packets.packets[i]!;
					const pts = presentation.get(oracle.pos)! * denominator / numerator;
					expect([packet!.sequenceNumber, packet!.timestamp, packet!.duration, packet!.type])
						.toEqual([i, pts, denominator / numerator, i === 0 ? 'key' : 'delta']);
					expect(`SHA256:${createHash('sha256').update(packet!.data).digest('hex')}`).toBe(oracle.data_hash);
					const meta = (await sink.getPacket(pts, { metadataOnly: true }))!;
					expect([meta.sequenceNumber, meta.timestamp, meta.byteLength, meta.type])
						.toEqual([i, pts, packet!.byteLength, packet!.type]);
					packet = await sink.getNextPacket(packet!);
				}
				expect(packet).toBeNull();
				for (const time of [0, 21, 24, 71, 95, 143, 238, 239, Infinity]) {
					const key = (await sink.getKeyPacket(time * denominator / numerator, { verifyKeyPackets: true }))!;
					expect(key.sequenceNumber).toBe(0);
				}
				expect(await sink.getNextKeyPacket((await sink.getFirstPacket())!)).toBeNull();
			}, 30000);
		}
	});
});
