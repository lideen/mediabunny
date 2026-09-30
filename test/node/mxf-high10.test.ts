import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { iterateNalUnitsInAnnexB } from '../../src/codec-data.js';

// Authored FFmpeg 7.1.1/libx264 testsrc2. Only 13 MXF index bytes were corrected;
// the unchanged Annex B payloads and presentation order were verified with FFmpeg.
const fixture = new URL('../public/mxf-avc-high10.mxf', import.meta.url);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const coding = Buffer.from('060e2b340401010a0401020201315001', 'hex');
const configuration = async (data: Buffer) => {
	using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
	return await (await input.getPrimaryVideoTrack())!.getDecoderConfig();
};
const firstSps = (data: Buffer) => {
	// ffprobe's first packet position and size, plus the frame-wrapping KLV header.
	const packet = data.subarray(6164, 6164 + 5254);
	const loc = [...iterateNalUnitsInAnnexB(packet)].find(loc => (packet[loc.offset]! & 31) === 7)!;
	return packet.subarray(loc.offset, loc.offset + loc.length);
};

describe('given progressive High 10 AVC in MXF', () => {
	describe('when seeking and reading a closed GOP with B-frames', () => {
		it('should preserve 10-bit Annex B pictures and their indexed presentation order', async () => {
			using input = new Input({ source: new FilePathSource(fileURLToPath(fixture)), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new EncodedPacketSink(track);
			const cold = (await sink.getPacket(0.6, { metadataOnly: true }))!;
			expect([cold.sequenceNumber, cold.timestamp, cold.type]).toEqual([15, 0.6, 'delta']);
			expect(await track.getDecoderConfig()).toMatchObject({
				codec: 'avc1.6e000c', codedWidth: 320, codedHeight: 192,
			});
			expect((await track.getDecoderConfig())!.description).toBeUndefined();
			expect(await track.hasOnlyKeyPackets()).toBe(false);
			expect(await track.getDurationFromMetadata()).toBe(0.64);
			const order = [0, 3, 1, 2, 6, 4, 5, 7, 8, 11, 9, 10, 14, 12, 13, 15];
			const hashes = createHash('sha256');
			let packet = await sink.getFirstPacket();
			for (let index = 0; index < order.length; index++) {
				expect([packet!.sequenceNumber, packet!.timestamp, packet!.duration, packet!.type])
					.toEqual([index, order[index]! / 25, 0.04, index % 8 === 0 ? 'key' : 'delta']);
				hashes.update(hash(packet!.data));
				packet = await sink.getNextPacket(packet!);
			}
			expect(packet).toBeNull();
			// Aggregate of independent ffprobe packet SHA-256 strings in decode order.
			expect(hashes.digest('hex')).toBe('e362626b3c6a76b92d757d4dd62e9f5dd7c0081b46ab7aeeb3502756e874f3c0');
			const backward = createHash('sha256');
			for (let index = 15; index >= 0; index--) {
				const found = (await sink.getPacket(order[index]! / 25))!;
				expect(found.sequenceNumber).toBe(index);
				backward.update(hash(found.data));
			}
			expect(backward.digest('hex')).toBe('5c426439bb603c2a0d7f5bcbad4e85b38e2dafb3028205bcd1ae7374161a92e6');
			for (const time of [Infinity, 0.32, 0.31, 0]) {
				expect((await sink.getKeyPacket(time, { verifyKeyPackets: true }))!.timestamp)
					.toBe(time >= 0.32 ? 0.32 : 0);
			}
		});
	});
	describe('when coded parameters contradict the declared profile', () => {
		it.each([0x80, 0x40, 0x20, 0x04, 0x02, 0x01])('should reject constraint bits %i', async (flags) => {
			const data = await readFile(fixture);
			firstSps(data)[2] = flags;
			await expect(configuration(data)).rejects.toThrow(/High 10.*constraints/);
		});
		it('should reject transform bypass even with matching profile, chroma and depth', async () => {
			const data = await readFile(fixture);
			// trace_headers bit 42: qpprime_y_zero_transform_bypass_flag, before any EPB.
			firstSps(data)[5]! |= 0x20;
			await expect(configuration(data)).rejects.toThrow(/transform bypass/);
		});
		it('should reject an Intra constraint on a long GOP SPS with reference pictures', async () => {
			const data = await readFile(fixture);
			firstSps(data)[2] = 0x10;
			await expect(configuration(data)).rejects.toThrow(/Intra.*reference frames/);
		});
		it.each([
			['4:2:2 chroma', 35], ['9-bit luma', 38], ['9-bit chroma', 41],
		] as const)('should reject unsupported %s', async (_, bit) => {
			const data = await readFile(fixture);
			firstSps(data)[Math.floor(bit / 8)]! ^= 1 << (7 - bit % 8);
			await expect(configuration(data)).rejects.toThrow(/High 10 requires progressive 8-bit or 10-bit 4:2:0/);
		});
		it.each([100, 122])('should reject a coded profile of %i under the High 10 label', async (profile) => {
			const data = await readFile(fixture);
			firstSps(data)[1] = profile;
			await expect(configuration(data)).rejects.toThrow(/SPS profile disagrees/);
		});
		it('should not admit a 10-bit High-profile SPS even when its label agrees', async () => {
			const data = await readFile(fixture);
			firstSps(data)[1] = 100;
			data[data.indexOf(coding) + 14] = 0x40;
			await expect(configuration(data)).rejects.toThrow(/progressive 8-bit 4:2:0/);
		});
		it.each([0x3301, 0x3302, 0x3308])('should reject contradictory CDCI field %i', async (tag) => {
			const data = await readFile(fixture);
			const header = Buffer.alloc(4);
			header.writeUInt16BE(tag);
			header.writeUInt16BE(4, 2);
			const offset = data.indexOf(header);
			expect(offset).toBeGreaterThan(0);
			data.writeUInt32BE(tag === 0x3301 ? 8 : 1, offset + 4);
			await expect(configuration(data)).rejects.toThrow(/SPS.*CDCI/);
		});
	});
	describe('when using registered High 10 variants', () => {
		it('should admit actual 8-bit SPS syntax under matching High 10 declarations', async () => {
			// Parameter admission only: libx264 emits High, not High 10, for this 8-bit producer sample.
			const data = await readFile(new URL('../public/mxf-avc420.mxf', import.meta.url));
			const originalCoding = Buffer.from('060e2b340401010a0401020201314001', 'hex');
			data.set(coding, data.indexOf(originalCoding));
			const packet = data.subarray(7188, 7188 + 4514);
			const loc = [...iterateNalUnitsInAnnexB(packet)].find(loc => (packet[loc.offset]! & 31) === 7)!;
			packet[loc.offset + 1] = 110;
			expect(await configuration(data))
				.toMatchObject({ codec: 'avc1.6e001f', codedWidth: 320, codedHeight: 192 });
		});
		it('should accept the published UL version and progressive-only constraint flag', async () => {
			const data = await readFile(fixture);
			data[data.indexOf(coding) + 7] = 0x0d;
			firstSps(data)[2] = 0x08;
			expect(await configuration(data)).toMatchObject({ codec: 'avc1.6e080c' });
		});
		it.each(['01315000', '01322001', '01322101', '01322102'])(
			'should reject a node or unsupported constrained leaf %s', async (leaf) => {
				const data = await readFile(fixture);
				data.set(Buffer.from(leaf, 'hex'), data.indexOf(coding) + 12);
				await expect(configuration(data)).rejects.toThrow(/unsupported AVC picture coding/);
			},
		);
	});
	describe('when restoring the producer-original temporal index', () => {
		it('should reject its wrong mapping rather than inventing presentation timestamps', async () => {
			const data = await readFile(fixture);
			for (const offset of [51323, 51356, 51371, 51386, 51401, 51416, 51431,
				51476, 51491, 51506, 51521, 51536, 51551]) {
				data[offset] = 0;
			}
			expect(hash(data)).toBe('9d1f1075dfd8611817939f70a7397aff863a6afa864a2d7c3278aea1381afe32');
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(0.04, { metadataOnly: true })).rejects.toThrow(/temporal index/);
		});
	});
});
