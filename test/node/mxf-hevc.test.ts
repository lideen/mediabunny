import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS, MXF } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, CustomSource, FilePathSource } from '../../src/source.js';
import { iterateNalUnitsInAnnexB } from '../../src/codec-data.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

// Authored testsrc2/sine, FFmpeg 7.1.1/libx265, in a self-authored ST 381-5 envelope,
// not producer MXF. SPS/VPS variants retain the decoded pictures of their source streams.
const readFixture = (depth: number | '42210') =>
	readFile(new URL(`../public/mxf-hevc-main${depth}.mxf`, import.meta.url));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

const klvs = (data: Buffer) => {
	const result: { key: string; start: number; value: Buffer; lengthSize: number }[] = [];
	for (let start = 0; start < data.length;) {
		const count = data[start + 16]! & 0x7f;
		const size = data.readUIntBE(start + 17, count);
		const offset = start + 17 + count;
		result.push({ key: data.subarray(start, start + 16).toString('hex'), start,
			value: data.subarray(offset, offset + size), lengthSize: 1 + count });
		start = offset + size;
	}
	return result;
};
const field = (data: Buffer, kind: string, tag: number) => {
	const set = klvs(data).find(x => x.key === `060e2b34025301010d0101010101${kind}`)!;
	for (let i = 0; i < set.value.length;) {
		const size = set.value.readUInt16BE(i + 2);
		if (set.value.readUInt16BE(i) === tag) {
			return set.value.subarray(i + 4, i + 4 + size);
		}
		i += 4 + size;
	}
	throw new Error('Fixture field not found');
};
const videoKlvs = (data: Buffer) => klvs(data).filter(x => x.key === '060e2b34010201010d01030115010500');
const nal = (data: Buffer, decode: number, type: number) => {
	const packet = videoKlvs(data)[decode]!.value;
	const loc = [...iterateNalUnitsInAnnexB(packet)].find(loc => ((packet[loc.offset]! >> 1) & 63) === type)!;
	return packet.subarray(loc.offset, loc.offset + loc.length);
};
const flipNalBit = (sps: Buffer, bit: number) => {
	let unescaped = 0;
	for (let i = 0; i < sps.length; i++) {
		if (i >= 2 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) {
			continue;
		}
		if (unescaped++ === Math.floor(bit / 8)) {
			sps[i]! ^= 1 << (7 - bit % 8);
			return;
		}
	}
	throw new Error('Fixture SPS bit not found');
};
const flipSpsBit = (data: Buffer, depth: number, name: string, bitWithin = 0) => {
	// FFmpeg trace_headers offsets in these fixtures' unescaped SPS NALs.
	const bits: Record<string, number> = {
		field_seq_flag: depth === 8 ? 239 : 243,
		chroma_format_idc: 121,
		general_profile_idc: 27,
		bit_depth_luma_minus8: 153,
		bit_depth_chroma_minus8: depth === 8 ? 154 : 156,
	};
	flipNalBit(nal(data, 0, 33), bits[name]! + bitWithin);
};
const configuration = async (data: Buffer) => {
	using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
	return await (await input.getPrimaryVideoTrack())!.getDecoderConfig();
};
const omitProperty = (data: Buffer, ul: string) => {
	const primer = klvs(data).find(x => x.key === '060e2b34020501010d01020101050100')!.value;
	const offset = primer.indexOf(Buffer.from(ul, 'hex'));
	expect(offset).toBeGreaterThan(0);
	// Retain the local item as an unknown property, without changing any offsets.
	primer[offset + 15] = 1;
};

describe.each([8, 10])('given real %i-bit HEVC in a self-authored ST 381-5 envelope', (depth) => {
	describe('when reading packets and seeking through two closed GOPs', () => {
		it('should preserve HEVC payloads, reordered presentation times, IDR restart points and PCM', async () => {
			using input = new Input({ source: new FilePathSource(fileURLToPath(new URL(
				`../public/mxf-hevc-main${depth}.mxf`, import.meta.url,
			))), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getCodec()).toBe('hevc');
			const config = (await track.getDecoderConfig())!;
			expect(config).toMatchObject({ codec: depth === 8 ? 'hev1.1.6.L30.90' : 'hev1.2.4.L30.90',
				codedWidth: 128, codedHeight: 96,
				colorSpace: { primaries: undefined, transfer: undefined, matrix: 'bt709', fullRange: false } });
			expect(config.description).toBeUndefined();
			expect(await track.canDecode()).toBe(false);
			const sink = new EncodedPacketSink(track);
			const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			// Independent FFmpeg decoded-frame order and SHA-256 of concatenated lowercase
			// packet SHA-256 strings, recorded before wrapping the elementary stream.
			const order = [0, 3, 2, 1, 5, 4, 6, 9, 8, 7, 11, 10];
			const videoHashes = createHash('sha256');
			const seekHashes = createHash('sha256');
			const audioHashes = createHash('sha256');
			let packet = await sink.getFirstPacket();
			for (const [decode, presentation] of order.entries()) {
				expect([packet!.sequenceNumber, packet!.timestamp, packet!.duration, packet!.type])
					.toEqual([decode, presentation / 25, 0.04, decode % 6 ? 'delta' : 'key']);
				videoHashes.update(hash(packet!.data));
				const found = (await sink.getPacket(presentation / 25))!;
				expect(found.sequenceNumber).toBe(decode);
				seekHashes.update(hash(found.data));
				const pcm = (await audio.getPacket(decode / 25))!;
				expect([pcm.sequenceNumber, pcm.timestamp, pcm.duration, pcm.byteLength])
					.toEqual([decode, decode / 25, 0.04, 3840]);
				audioHashes.update(hash(pcm.data));
				packet = await sink.getNextPacket(packet!);
			}
			expect(packet).toBeNull();
			const expectedVideoHash = depth === 8
				? '746e743c211f4d428c0923a9968b8e7e2085fd93b0c6a550f14688750f067f95'
				: '1dbfaa7d8e0a4f237676d8edf68034c50de717909bb692958b64301985d25630';
			expect(videoHashes.digest('hex')).toBe(expectedVideoHash);
			expect(seekHashes.digest('hex')).toBe(expectedVideoHash);
			expect(audioHashes.digest('hex')).toBe('e0c937aaeaeca888b9aee04f671b6844e560a17c9b8a37aa8d0ed719ff22550a');
			expect(await audio.getNextPacket((await audio.getPacket(11 / 25))!)).toBeNull();
			for (const time of [0.04, 0.12, 0.239, 0.24, 0.4, Infinity]) {
				const key = (await sink.getKeyPacket(time, { verifyKeyPackets: true }))!;
				expect(key.timestamp).toBe(time < 0.24 ? 0 : 0.24);
			}
			const first = (await sink.getFirstPacket())!;
			expect((await sink.getNextKeyPacket(first, { verifyKeyPackets: true }))!.timestamp).toBe(0.24);
		});
	});

	describe('when the descriptor contradicts the encoded picture', () => {
		it.each([
			[0x3301, depth === 8 ? 10 : 8, /CDCI/], [0x3302, 1, /CDCI/], [0x3308, 1, /CDCI/],
			[0x3203, 130, /geometry/], [0x320c, 1, /interlaced/],
		] as const)('should reject descriptor tag %i', async (tag, value, error) => {
			const data = await readFixture(depth);
			const item = field(data, '2800', tag);
			item.writeUIntBE(value, 0, item.length);
			await expect(configuration(data)).rejects.toThrow(error);
		});
		it('should reject an inconsistent display aspect ratio', async () => {
			const data = await readFixture(depth);
			field(data, '2800', 0x320e).writeUInt32BE(5);
			await expect(configuration(data)).rejects.toThrow(/aspect ratio/);
		});
	});

	describe('when the HEVC subdescriptor contradicts the stream', () => {
		it.each([
			[0x8201, depth === 8 ? 2 : 1, /subdescriptor/],
			[0x8202, 60, /subdescriptor/], [0x8203, 2, /field pictures/], [0x8204, 2, /closed GOP indicator/],
			[0x8205, 0xb000, /subdescriptor/], [0x8206, 1, /subdescriptor/], [0x8207, 0xc0, /parameter-set flags/],
		] as const)('should reject subdescriptor tag %i', async (tag, value, error) => {
			const data = await readFixture(depth);
			const item = field(data, '8101', tag);
			item.writeUIntBE(value, 0, item.length);
			await expect(configuration(data)).rejects.toThrow(error);
		});
		it('should enforce an every-access-unit parameter-set declaration', async () => {
			const data = await readFixture(depth);
			field(data, '8101', 0x8209)[0] = 0xa0;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(0.12)).rejects.toThrow(/parameter-set presence/);
		});
		it('should reject zero decoding delay when the index actually reorders pictures', async () => {
			const data = await readFixture(depth);
			field(data, '8101', 0x8200)[0] = 0;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(0.12, { metadataOnly: true })).rejects.toThrow(/zero decoding delay/);
		});
		it('should reject a subdescriptor with no mandatory decoding delay', async () => {
			const data = await readFixture(depth);
			omitProperty(data, '060e2b340101010e04010606020e0000');
			await expect(configuration(data)).rejects.toThrow(/missing or invalid property/);
		});
		it('should reject a first-access-unit-only parameter declaration contradicted by a later GOP', async () => {
			const data = await readFixture(depth);
			field(data, '8101', 0x8209)[0] = 0x90;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(0.24)).rejects.toThrow(/parameter-set presence/);
		});
	});

	describe('when optional HEVC metadata is absent or unknown', () => {
		it('should obtain configuration from in-band parameters without a subdescriptor', async () => {
			const data = await readFixture(depth);
			omitProperty(data, '060e2b34010101090601010406100000');
			expect((await configuration(data))!.codec).toBe(depth === 8 ? 'hev1.1.6.L30.90' : 'hev1.2.4.L30.90');
		});
		it('should use the actual index and SPS when GOP/content/parameter declarations are unknown', async () => {
			const data = await readFixture(depth);
			for (const tag of [0x8203, 0x8204, 0x8207, 0x8208, 0x8209]) {
				field(data, '8101', tag)[0] = 0;
			}
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			expect((await sink.getKeyPacket(0.24))!.timestamp).toBe(0.24);
		});
	});

	describe('when the SPS exceeds the supported HEVC subset', () => {
		it.each([
			['field_seq_flag', 0, /progressive Main/], ['chroma_format_idc', 2, /progressive Main/],
			['general_profile_idc', 4, /SPS profile/],
		] as const)('should reject SPS field %s', async (name, offset, error) => {
			const data = await readFixture(depth);
			flipSpsBit(data, depth, name, offset);
			await expect(configuration(data)).rejects.toThrow(error);
		});
	});

	describe('when an indexed key packet cannot restart the decoder', () => {
		it.each([0, 6])('should reject missing VPS at decode position %i', async (decode) => {
			const data = await readFixture(depth);
			nal(data, decode, 32)[0] = 39 << 1;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(decode / 25)).rejects.toThrow(/VPS\/SPS\/PPS/);
		});
		it.each([6, 7, 8, 9, 16, 19, 21])('should reject unsupported restart NAL type %i', async (type) => {
			const data = await readFixture(depth);
			nal(data, 6, 20)[0] = type << 1;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(0.24)).rejects.toThrow(/other restart types are unsupported/);
		});
		it('should reject parameter changes on a cold key seek', async () => {
			const data = await readFixture(depth);
			nal(data, 6, 34)[2]! ^= 0x10;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(0.24)).rejects.toThrow(/stable VPS\/SPS\/PPS/);
		});
	});
});

describe('given authored Main 4:2:2 10 HEVC in a standard ST 381-5 envelope', () => {
	describe('when reading without a native decoder', () => {
		it('should preserve configuration, cold seeks and every indexed picture payload', async () => {
			using input = new Input({ source: new FilePathSource(fileURLToPath(new URL(
				'../public/mxf-hevc-main42210.mxf', import.meta.url,
			))), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getCodec()).toBe('hevc');
			const sink = new EncodedPacketSink(track);
			const cold = (await sink.getPacket(0.6, { metadataOnly: true }))!;
			expect([cold.sequenceNumber, cold.timestamp, cold.duration, cold.type]).toEqual([15, 0.6, 0.04, 'delta']);
			const restart = (await sink.getKeyPacket(0.6, { verifyKeyPackets: true }))!;
			expect([restart.sequenceNumber, restart.timestamp, restart.type]).toEqual([8, 0.32, 'key']);
			expect(hash(restart.data)).toBe('1a302a267fb8a42df080fc0535c98947e1678c07e64dd3cb3a1f284a9ff0afa6');
			expect(await track.getDecoderConfig()).toMatchObject({
				codec: 'hev1.4.10.L60.9D.8', codedWidth: 320, codedHeight: 192,
				displayAspectWidth: 5, displayAspectHeight: 3,
				colorSpace: { primaries: undefined, transfer: undefined, matrix: undefined, fullRange: false },
			});
			expect((await track.getDecoderConfig())!.description).toBeUndefined();
			expect(await track.canDecode()).toBe(false);
			// FFmpeg 7.1.1 decoded order and encoded packet hashes from the authored x265 stream,
			// before wrapping. Two IDR_N_LP GOPs, no B pictures; SHA-256 over lowercase packet hashes.
			const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
			const sequential = createHash('sha256');
			const sought = createHash('sha256');
			let packet = await sink.getFirstPacket();
			for (const [decode, presentation] of order.entries()) {
				expect([packet!.sequenceNumber, packet!.timestamp, packet!.duration, packet!.type])
					.toEqual([decode, presentation / 25, 0.04, decode % 8 ? 'delta' : 'key']);
				sequential.update(hash(packet!.data));
				const found = (await sink.getPacket(presentation / 25))!;
				expect(found.sequenceNumber).toBe(decode);
				sought.update(hash(found.data));
				packet = await sink.getNextPacket(packet!);
			}
			expect(packet).toBeNull();
			const expected = 'c8185dbfdca2f679ff867b0a9b6645e7c84b52477204bbc4fd16f0360cc48944';
			expect(sequential.digest('hex')).toBe(expected);
			expect(sought.digest('hex')).toBe(expected);
			expect(await sink.getNextKeyPacket(restart)).toBeNull();
		});
	});
	describe('when SPS declarations do not identify the supported progressive 10-bit 4:2:2 subset', () => {
		it.each([
			['profile space', 24, /SPS profile/],
			['max 12-bit', 68, /profile constraints/], ['max 10-bit', 69, /profile constraints/],
			['max 8-bit', 70, /profile constraints/], ['max 4:2:2', 71, /profile constraints/],
			['max 4:2:0', 72, /profile constraints/], ['monochrome', 73, /profile constraints/],
			['intra', 74, /profile constraints/], ['one picture', 75, /profile constraints/],
			['lower bit rate', 76, /profile constraints/],
			['interlaced source', 65, /progressive Main/], ['field sequence', 219, /progressive Main/],
			['actual 4:2:0', 123, /progressive Main/],
			['9-bit luma', 159, /progressive Main/], ['9-bit chroma', 162, /progressive Main/],
		] as const)('should reject %s', async (_, bit, error) => {
			const data = await readFixture('42210');
			// Offsets from FFmpeg trace_headers on the original authored SPS.
			flipNalBit(nal(data, 0, 33), bit);
			await expect(configuration(data)).rejects.toThrow(error);
		});
		it('should reject equal but unsupported 9-bit component depths', async () => {
			const data = await readFixture('42210');
			for (const bit of [159, 162]) {
				flipNalBit(nal(data, 0, 33), bit);
			}
			await expect(configuration(data)).rejects.toThrow(/progressive Main/);
		});
		it('should reject a different profile without format-range compatibility', async () => {
			const data = await readFixture('42210');
			for (const bit of [31, 36]) {
				flipNalBit(nal(data, 0, 33), bit);
			}
			await expect(configuration(data)).rejects.toThrow(/SPS profile/);
		});
	});
	describe('when MXF metadata contradicts the Main 4:2:2 10 stream', () => {
		it.each([
			['2800', 0x3301, 8, /CDCI/], ['2800', 0x3301, 12, /CDCI/],
			['2800', 0x3302, 1, /CDCI/], ['2800', 0x3308, 2, /CDCI/],
			['2800', 0x320c, 1, /interlaced/],
			['8101', 0x8201, 2, /subdescriptor/], ['8101', 0x8202, 90, /subdescriptor/],
			['8101', 0x8206, 1, /subdescriptor/], ['8101', 0x8205, 0x4000, /subdescriptor/],
			['8101', 0x8205, 0x7430, /subdescriptor/], ['8101', 0x8205, 0x7421, /subdescriptor/],
		] as const)('should reject set %s tag %i value %i', async (kind, tag, value, error) => {
			const data = await readFixture('42210');
			const item = field(data, kind, tag);
			item.writeUIntBE(value, 0, item.length);
			await expect(configuration(data)).rejects.toThrow(error);
		});
		it('should reject the registered profile parent node as a coding label', async () => {
			const data = await readFixture('42210');
			field(data, '2800', 0x3201)[15] = 0;
			await expect(configuration(data)).rejects.toThrow(/unsupported HEVC picture coding/);
		});
		it('should compare the raw profile, not profile 4, when compatibility selects the format', async () => {
			const data = await readFixture('42210');
			// Adversarial PTL, not a claim that this stream conforms to High Throughput profile 5.
			flipNalBit(nal(data, 0, 33), 31);
			await expect(configuration(data)).rejects.toThrow(/subdescriptor disagrees with SPS/);
		});
		it('should still require exact range-extension constraints with profile compatibility', async () => {
			const data = await readFixture('42210');
			for (const bit of [31, 71]) {
				flipNalBit(nal(data, 0, 33), bit);
			}
			await expect(configuration(data)).rejects.toThrow(/profile constraints/);
		});
		it.each([5, 9, 10, 11])('should project max-14-bit syntax for a compatible raw profile %i', async (profile) => {
			const data = await readFixture('42210');
			// Only tests contradictory metadata: these alternate profile declarations are not producer evidence.
			for (let bit = 0; bit < 5; bit++) {
				if (((4 ^ profile) >> (4 - bit)) & 1) {
					flipNalBit(nal(data, 0, 33), 27 + bit);
				}
			}
			flipNalBit(nal(data, 0, 33), 77);
			field(data, '8101', 0x8201)[0] = profile;
			await expect(configuration(data)).rejects.toThrow(/subdescriptor disagrees with SPS/);
		});
		it('should not project a reserved profile-4 bit as max-14-bit', async () => {
			const data = await readFixture('42210');
			flipNalBit(nal(data, 0, 33), 77);
			field(data, '8101', 0x8205).writeUInt16BE(0x7430);
			await expect(configuration(data)).rejects.toThrow(/subdescriptor disagrees with SPS/);
		});
		it('should use compatibility flags to determine max-14-bit syntax presence', async () => {
			const data = await readFixture('42210');
			for (const bit of [37, 77]) {
				flipNalBit(nal(data, 0, 33), bit);
			}
			await expect(configuration(data)).rejects.toThrow(/subdescriptor disagrees with SPS/);
		});
	});
	describe('when progressive pictures do not set the frame-only constraint', () => {
		it('should use FrameLayout and field_seq_flag and project the actual constraint bits', async () => {
			const data = await readFixture('42210');
			for (const decode of [0, 8]) {
				flipNalBit(nal(data, decode, 33), 67);
				flipNalBit(nal(data, decode, 32), 91);
			}
			field(data, '8101', 0x8205).writeUInt16BE(0x3420);
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			expect((await track.getDecoderConfig())!.codec).toBe('hev1.4.10.L60.8D.8');
			expect((await new EncodedPacketSink(track).getKeyPacket(0.32))!.timestamp).toBe(0.32);
		});
	});
	describe('when optional CDCI and HEVC subdescriptor metadata is absent', () => {
		it('should derive the configuration from actual in-band parameters', async () => {
			const data = await readFixture('42210');
			for (const ul of [
				'060e2b34010101090601010406100000', '060e2b3401010102040105030a000000',
				'060e2b34010101010401050105000000', '060e2b34010101020401050110000000',
			]) {
				omitProperty(data, ul);
			}
			expect((await configuration(data))!.codec).toBe('hev1.4.10.L60.9D.8');
		});
	});
});

describe.each([10, '42210'] as const)('given HEVC Main%s declared at High Tier Level 4', (profile) => {
	describe('when tier and level agree between in-band parameters and MXF', () => {
		it('should preserve the signalled tier and level without changing profile constraints', async () => {
			const data = await readFixture(profile);
			const oldLevel = profile === 10 ? 30 : 60;
			const secondIdr = profile === 10 ? 6 : 8;
			for (const decode of [0, secondIdr]) {
				for (const type of [32, 33]) {
					const parameter = nal(data, decode, type);
					const offset = type === 32 ? 24 : 0;
					flipNalBit(parameter, offset + 26);
					for (let bit = 0; bit < 8; bit++) {
						if (((oldLevel ^ 120) >> (7 - bit)) & 1) {
							flipNalBit(parameter, offset + 112 + bit);
						}
					}
				}
			}
			field(data, '8101', 0x8202)[0] = 120;
			field(data, '8101', 0x8206)[0] = 1;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			expect((await track.getDecoderConfig())!.codec)
				.toBe(profile === 10 ? 'hev1.2.4.H120.90' : 'hev1.4.10.H120.9D.8');
			expect((await new EncodedPacketSink(track).getKeyPacket(secondIdr / 25))!.timestamp).toBe(secondIdr / 25);
		});
	});
});

describe('given sparse HEVC descriptor/index metadata with unallocated essence', () => {
	describe('when seeking near the end without reading payloads', () => {
		it('should retain bounded indexed reads across a ten GB logical file', async () => {
			const fixture = makeIndexedMxf({ avc: true, ber: true, avcCoding: '060e2b340401010d0401020201411001' });
			const header = fixture.regions[0]!.data;
			for (const [before, after] of [
				['060e2b340401010a0d01030102106001', '060e2b340401010d0d01030102206001'],
				['060e2b34025301010d01010101015100', '060e2b34025301010d01010101012800'],
			]) {
				const offset = Buffer.from(header).indexOf(Buffer.from(before!, 'hex'));
				expect(offset).toBeGreaterThan(0);
				header.set(Buffer.from(after!, 'hex'), offset);
			}
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				prefetchProfile: 'none', read: fixture.read }), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getCodec()).toBe('hevc');
			const found = (await new EncodedPacketSink(track).getPacket(390, { metadataOnly: true }))!;
			expect([found.timestamp, found.sequenceNumber, found.type]).toEqual([390, 9751, 'delta']);
			expect(fixture.reads.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThan(24000);
			expect(fixture.reads.length).toBeLessThan(40);
			for (const [start, end] of fixture.reads) {
				for (let p = 0; p < fixture.offsets.length; p++) {
					const body = fixture.offsets[p]! + 108;
					const bodyEnd = fixture.offsets[p + 1] ?? fixture.footerOffset;
					if (start >= body && start < bodyEnd) {
						const within = (start - body) % fixture.stride;
						expect(within).toBeLessThan(52);
						expect(end - start + within).toBeLessThanOrEqual(57);
					}
				}
			}
		});
	});
});

describe('given unsupported HEVC mappings or temporal indexes', () => {
	describe('when one picture changes the track BER length width', () => {
		it('should reject mixed four- and five-byte lengths without reading the picture payload', async () => {
			const data = await readFixture(8);
			const first = videoKlvs(data)[0]!;
			data[first.start + 16] = 0x84;
			data.writeUInt32BE(first.value.length - 1, first.start + 17);
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const packet = (await sink.getFirstPacket({ metadataOnly: true }))!;
			await expect(sink.getNextPacket(packet, { metadataOnly: true })).rejects.toThrow(/constant.*BER lengths/);
		});
	});
	describe('when Main10 SPS depths are unsupported or unequal', () => {
		it.each([false, true])('should reject 9-bit luma with matching chroma %s', async (matchingChroma) => {
			const data = await readFixture(10);
			flipSpsBit(data, 10, 'bit_depth_luma_minus8', 2);
			if (matchingChroma) {
				flipSpsBit(data, 10, 'bit_depth_chroma_minus8', 2);
			}
			await expect(configuration(data)).rejects.toThrow(/progressive Main/);
		});
	});
	describe('when the container label does not describe the supported Annex B mapping', () => {
		it('should reject HEVC OPAtom', async () => {
			const data = await readFixture(8);
			for (const part of klvs(data).filter(x => x.key.startsWith('060e2b34020501010d010201010')
				&& ['02', '03', '04'].includes(x.key.slice(26, 28)))) {
				part.value.set(Buffer.from('060e2b34040101010d01020110000000', 'hex'), 64);
			}
			await expect(configuration(data)).rejects.toThrow(/OPAtom/);
		});
		it.each(['021f6001', '02206002', '02206009', '02206007', '02206101'])(
			'should reject container suffix %s', async (suffix) => {
				const data = await readFixture(8);
				field(data, '2800', 0x3004).set(Buffer.from(`060e2b340401010d0d010301${suffix}`, 'hex'));
				await expect(configuration(data)).rejects.toThrow(/frame wrapping/);
			},
		);
		it.each(['01411000', '01412000', '01413001'])(
			'should reject picture coding suffix %s', async (suffix) => {
				const data = await readFixture(8);
				field(data, '2800', 0x3201).set(Buffer.from(`060e2b340401010d04010202${suffix}`, 'hex'));
				await expect(configuration(data)).rejects.toThrow(/unsupported HEVC picture coding/);
			},
		);
	});
	describe('when temporal entries cannot identify a closed IDR GOP', () => {
		it.each([[0, 1, /unique inverse/], [2, 0xcc, /overflow/], [2, 0xc0, /IDR random access/]])(
			'should reject index byte %i set to %i', async (byte, value, error) => {
				const data = await readFixture(8);
				const index = klvs(data).find(x => x.key === '060e2b34025301010d01020101100100')!.value;
				let offset = 0;
				while (index.readUInt16BE(offset) !== 0x3f0a) {
					offset += 4 + index.readUInt16BE(offset + 2);
				}
				index[offset + 4 + 8 + byte] = value;
				await expect(configuration(data)).rejects.toThrow(error);
			},
		);
	});
});

describe('given Main-compatible 8-bit essence declared as Main10', () => {
	describe('when VPS, SPS and descriptors consistently select profile 2', () => {
		it('should admit the 8-bit subset of Main10 without inventing a 10-bit requirement', async () => {
			const data = await readFixture(8);
			const profileBit = 27;
			for (const decode of [0, 6]) {
				for (const offset of [3, 4]) {
					flipNalBit(nal(data, decode, 33), profileBit + offset);
					// FFmpeg trace_headers places VPS general_profile_idc at bit 51.
					flipNalBit(nal(data, decode, 32), 51 + offset);
				}
			}
			field(data, '2800', 0x3201)[14] = 0x20;
			field(data, '8101', 0x8201)[0] = 2;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			expect((await track.getDecoderConfig())!.codec).toBe('hev1.2.6.L30.90');
			const sink = new EncodedPacketSink(track);
			expect((await sink.getKeyPacket(0.24))!.timestamp).toBe(0.24);
		});
	});
});

describe('given HEVC with display aspect specified only by MXF', () => {
	describe.each(['sar-absent', 'sar-unspecified', 'vui-absent'])('when the SPS has %s', (variant) => {
		it('should preserve the container display ratio in track metadata and decoder configuration', async () => {
			using input = new Input({ source: new FilePathSource(fileURLToPath(new URL(
				`../public/mxf-hevc-${variant}.mxf`, import.meta.url,
			))), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getDisplayWidth() / await track.getDisplayHeight()).toBeCloseTo(16 / 9);
			const config = (await track.getDecoderConfig())!;
			expect([config.codedWidth, config.codedHeight]).toEqual([128, 96]);
			expect(config.displayAspectWidth! / config.displayAspectHeight!).toBeCloseTo(16 / 9);
			const sink = new EncodedPacketSink(track);
			expect((await sink.getKeyPacket(0.24))!.timestamp).toBe(0.24);
		});
	});
});

describe('given a single Main10 IDR picture with one-picture-only constraints', () => {
	describe('when the ST 381-5 subdescriptor projects the SPS constraints', () => {
		it('should accept bit 6 and deliver the only picture', async () => {
			using input = new Input({ source: new FilePathSource(fileURLToPath(new URL(
				'../public/mxf-hevc-main10-one-picture.mxf', import.meta.url,
			))), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			expect((await track.getDecoderConfig())!.codec).toBe('hev1.2.4.L30.90.10');
			const sink = new EncodedPacketSink(track);
			const first = (await sink.getFirstPacket())!;
			expect([first.type, first.timestamp, first.duration]).toEqual(['key', 0, 0.04]);
			expect(await sink.getNextPacket(first)).toBeNull();
		});
	});
});

describe('given HEVC SPS with an unused long-term reference picture', () => {
	describe('when configuration parsing continues through the remaining VUI', () => {
		it('should retain geometry, aspect and color after the fixed-width POC LSB', async () => {
			using input = new Input({ source: new FilePathSource(fileURLToPath(new URL(
				'../public/mxf-hevc-main10-long-term.mxf', import.meta.url,
			))), formats: ALL_FORMATS });
			const config = await (await input.getPrimaryVideoTrack())!.getDecoderConfig();
			expect(config).toMatchObject({ codec: 'hev1.2.4.L30.90', codedWidth: 128, codedHeight: 96,
				colorSpace: { primaries: undefined, transfer: undefined, matrix: 'bt709', fullRange: false } });
		});
	});
});
