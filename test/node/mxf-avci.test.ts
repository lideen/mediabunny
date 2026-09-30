import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, CustomSource, FilePathSource } from '../../src/source.js';
import { addEmulationPreventionBytes, iterateNalUnitsInAnnexB } from '../../src/codec-data.js';

// Unmodified FFmpeg 7.1.1/libx264 OP1a output from authored testsrc2, not camera footage.
const readFixture = (format: string) => readFile(new URL(`../public/mxf-avci${format}.mxf`, import.meta.url));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const klvs = (data: Buffer) => {
	const result: { key: string; start: number; value: Buffer }[] = [];
	for (let start = 0; start < data.length;) {
		const first = data[start + 16]!;
		const width = first & 128 ? first & 127 : 0;
		const size = width ? data.readUIntBE(start + 17, width) : first;
		const offset = start + 17 + width;
		result.push({ key: data.subarray(start, start + 16).toString('hex'), start,
			value: data.subarray(offset, offset + size) });
		start = offset + size;
	}
	return result;
};
const localFields = (data: Buffer) => {
	const fields = new Map<number, Buffer>();
	for (let offset = 0; offset < data.length;) {
		const tag = data.readUInt16BE(offset);
		const size = data.readUInt16BE(offset + 2);
		fields.set(tag, data.subarray(offset + 4, offset + 4 + size));
		offset += 4 + size;
	}
	return fields;
};
const descriptorField = (data: Buffer, tag: number) => localFields(klvs(data)
	.find(x => x.key === '060e2b34025301010d01010101015100')!.value).get(tag)!;
const omitDescriptorField = (data: Buffer, tag: number) => {
	const items = klvs(data);
	const descriptor = items.find(x => x.key === '060e2b34025301010d01010101015100')!;
	const fill = items.find(x => x.start > descriptor.start && x.key === '060e2b34010101020301021001000000')!;
	const field = localFields(descriptor.value).get(tag)!;
	const start = field.byteOffset - data.byteOffset - 4;
	const size = field.length + 4;
	expect([data[descriptor.start + 16], data[fill.start + 16]]).toEqual([0x83, 0x83]);
	// Absorb the removed local item into the following Fill without moving any essence or index.
	data.copyWithin(start, start + size, fill.value.byteOffset - data.byteOffset);
	data.writeUIntBE(descriptor.value.length - size, descriptor.start + 17, 3);
	data.writeUIntBE(fill.value.length + size, fill.start - size + 17, 3);
};
const indexField = (data: Buffer, tag: number) => localFields(klvs(data)
	.find(x => x.key === '060e2b34025301010d01020101100100')!.value).get(tag)!;
const setRate = (data: Buffer, numerator: number) => {
	for (const klv of klvs(data).filter(x => x.key.startsWith('060e2b34025301010d01'))) {
		for (const [tag, value] of localFields(klv.value)) {
			if ([0x4b01, 0x3001, 0x3f0b].includes(tag)) {
				value.writeUInt32BE(numerator);
			}
		}
	}
};
const pictureKlvs = (data: Buffer) => klvs(data).filter(x => x.key === '060e2b34010201010d01030115010500');
const nal = (data: Buffer, frame: number, type: number) => {
	const packet = pictureKlvs(data)[frame]!.value;
	const loc = [...iterateNalUnitsInAnnexB(packet)].find(loc => (packet[loc.offset]! & 31) === type)!;
	return packet.subarray(loc.offset, loc.offset + loc.length);
};
const flipSpsBit = (data: Buffer, bit: number) => {
	const sps = nal(data, 0, 7);
	let unescaped = 0;
	for (let offset = 0; offset < sps.length; offset++) {
		if (offset >= 2 && sps[offset] === 3 && sps[offset - 1] === 0 && sps[offset - 2] === 0) {
			continue;
		}
		if (unescaped++ === Math.floor(bit / 8)) {
			sps[offset]! ^= 1 << (7 - bit % 8);
			return;
		}
	}
	throw new Error('Fixture SPS bit not found');
};
const replaceSpsBits = (data: Buffer, start: number, length: number, replacement: string) => {
	const sps = nal(data, 0, 7);
	const rbsp = sps.filter((byte, i) => !(i >= 2 && byte === 3 && sps[i - 1] === 0 && sps[i - 2] === 0));
	const bits = [...rbsp].map(byte => byte.toString(2).padStart(8, '0')).join('');
	const edited = bits.slice(0, start) + replacement + bits.slice(start + length);
	const bytes = Buffer.alloc(Math.ceil(edited.length / 8));
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(edited.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2);
	}
	const encoded = addEmulationPreventionBytes(bytes);
	const packet = pictureKlvs(data)[0]!.value;
	const offset = sps.byteOffset - packet.byteOffset;
	// Keep the fixed AU size by consuming trailing filler bytes, not the next MXF KLV.
	packet.copyWithin(offset + encoded.length, offset + sps.length);
	packet.set(encoded, offset);
};
const configuration = async (data: Buffer) => {
	using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
	return await (await input.getPrimaryVideoTrack())!.getDecoderConfig();
};

describe.each([
	['100-720p50', 1280, 720, 50, 284672, 285696, 'avc1.7a1029',
		'107dd57e77cc7f1ccbc9d9e0397c51c696f793b2205080fafafcaba092471579',
		'075f2cf564c4dc2c605895c47d6afd078b8f829b4a82c4635dbee368cc405fa4',
		'6ce279351f0e65a315867b548142947fde3086eb8c3750f83f11da10e738e0c1'],
	['100-1080p25', 1920, 1080, 25, 568832, 569856, 'avc1.7a1029',
		'4026f9df0551623ee66abb8ce5b487860a4584ffa031d827636cd82ccb32a8ca',
		'252e456b74ff612ffafce5efb0fd4ccdbe447c3e7d98ac5594e2cd6726d5c4a5',
		'817809ec5f16388901eec84c762e07d66803e8143282ecaf165b8c7d82ee3919'],
	['50-720p50', 960, 720, 50, 140800, 141824, 'avc1.6e1020',
		'd707746af6b09c90d0bb9e00297d9489eb4dab88dbac118ee491adb8a8354383',
		'4bbe927d02c940c0fdc377255238e2ad81f3e8421e257ef53c3fdb2aceeb52b2',
		'0baac860c8c95d3de17f6ab6e05e09c9c4e1a46004fe7bf051e365bbc58339d6'],
	['50-1080p25', 1440, 1080, 25, 281088, 282112, 'avc1.6e1028',
		'f757836224914810bbc45e6f4498693751e685019d55dfeeb7b198e7dddd6823',
		'be1eeb3f597db4a6a9a233fdeeb0d4f5f9ab639e405dd396afc43f5155dd6391',
		'8a02efeb16b24eaff4c5399fc37a0f7d76e90fb3685ca7374186a7762531edc2'],
] as const)('given producer AVC-Intra %s with ordinary CBE and no IndexEntryArray',
	(format, width, height, rate, size, stride, codec, expectedHash, lastHash, backwardHash) => {
		const class50 = format.startsWith('50-');
		describe('when opening the producer file through FilePathSource', () => {
			it('should preserve coding-label identity without lending out the stored metadata bytes', async () => {
				using input = new Input({ source: new FilePathSource(fileURLToPath(new URL(
					`../public/mxf-avci${format}.mxf`, import.meta.url,
				))), formats: ALL_FORMATS });
				const track = (await input.getPrimaryVideoTrack())!;
				const expected = Buffer.from(`060e2b340401010a040102020132${class50 ? '21' : '31'}0${
					height === 720 ? 9 : 4}`, 'hex');
				const id = await track.getInternalCodecId();
				expect(id).toEqual(new Uint8Array(expected));
				if (!(id instanceof Uint8Array)) {
					throw new Error('Expected an MXF coding UL');
				}
				id.fill(0);
				expect(await track.getInternalCodecId()).toEqual(new Uint8Array(expected));
				const sink = new EncodedPacketSink(track);
				expect(hash((await sink.getKeyPacket(Infinity))!.data)).toBe(lastHash);
			});
		});
		describe('when seeking cold before reading any picture', () => {
			it('should honor the system-item delta and deliver self-contained original key packets', async () => {
				const data = await readFixture(format);
				const reads: [number, number][] = [];
				using input = new Input({ source: new CustomSource({ getSize: () => data.length,
					prefetchProfile: 'none', read: (start, end) => {
						reads.push([start, end]);
						return data.subarray(start, end);
					} }), formats: ALL_FORMATS });
				const track = (await input.getPrimaryVideoTrack())!;
				expect(await track.getCodec()).toBe('avc');
				expect(await track.getDurationFromMetadata()).toBe(4 / rate);
				const sink = new EncodedPacketSink(track);
				const metadata = (await sink.getKeyPacket(Infinity, { metadataOnly: true }))!;
				expect([metadata.sequenceNumber, metadata.timestamp, metadata.duration,
					metadata.type, metadata.byteLength])
					.toEqual([3, 3 / rate, 1 / rate, 'key', size]);
				expect(reads.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThan(24000);
				// ffprobe locates the first picture KLV at 6144, 512 bytes after the system item.
				// A cold indexed seek must not walk the two intervening content packages.
				for (const [start, end] of reads) {
					for (const index of [1, 2]) {
						const offset = 6144 + index * stride;
						expect(end <= offset || start >= offset + 20 + size).toBe(true);
					}
				}
				const last = (await sink.getKeyPacket(Infinity, { verifyKeyPackets: true }))!;
				expect([last.sequenceNumber, last.timestamp, last.duration, last.type, last.byteLength])
					.toEqual([3, 3 / rate, 1 / rate, 'key', size]);
				expect(hash(last.data)).toBe(lastHash);
				const config = (await track.getDecoderConfig())!;
				expect(config).toMatchObject({ codec, codedWidth: width, codedHeight: height });
				expect([await track.getCodedWidth(), await track.getCodedHeight(),
					await track.getDisplayWidth(), await track.getDisplayHeight()])
					.toEqual([width, height, height === 720 ? 1280 : 1920, height]);
				expect(await track.getPixelAspectRatio()).toEqual(class50 ? { num: 4, den: 3 } : { num: 1, den: 1 });
				if (class50) {
					expect(config).toMatchObject({ displayAspectWidth: 16, displayAspectHeight: 9 });
				}
				expect(config.description).toBeUndefined();
				expect(await track.hasOnlyKeyPackets()).toBe(true);
				// Independent ffprobe packet hashes and decoded order: every picture is an IDR.
				const hashes = createHash('sha256');
				let packet = await sink.getFirstPacket();
				for (const index of [0, 1, 2, 3]) {
					expect([packet!.sequenceNumber, packet!.timestamp, packet!.duration,
						packet!.type, packet!.byteLength])
						.toEqual([index, index / rate, 1 / rate, 'key', size]);
					hashes.update(hash(packet!.data));
					packet = await sink.getNextKeyPacket(packet!, { verifyKeyPackets: true });
				}
				expect(packet).toBeNull();
				expect(hashes.digest('hex')).toBe(expectedHash);
				const backward = createHash('sha256');
				for (const index of [3, 2, 1, 0]) {
					const found = (await sink.getKeyPacket(index / rate))!;
					expect(found.sequenceNumber).toBe(index);
					backward.update(hash(found.data));
				}
				expect(backward.digest('hex')).toBe(backwardHash);
			});
		});
		describe('when container declarations exceed the supported progressive AVC-Intra subset', () => {
			it.each(['01323100', '01323101', '01323102', '01323001', '01323209',
				'01322100', '01322101', '01322102', '01322001'])(
				'should reject coding leaf %s', async (leaf) => {
					const data = await readFixture(format);
					descriptorField(data, 0x3201).set(Buffer.from(`060e2b340401010a04010202${leaf}`, 'hex'));
					await expect(configuration(data)).rejects.toThrow(/unsupported AVC picture coding/);
				},
			);
			it('should reject a valid leaf for the other raster', async () => {
				const data = await readFixture(format);
				descriptorField(data, 0x3201)[15] = height === 720 ? 4 : 9;
				await expect(configuration(data)).rejects.toThrow(/descriptor raster/);
			});
			it.each([3, 8])('should reject a fractional-rate leaf %i with integer-rate essence', async (leaf) => {
				const data = await readFixture(format);
				descriptorField(data, 0x3201)[15] = leaf;
				await expect(configuration(data)).rejects.toThrow(/edit rate/);
			});
			it('should reject an unsupported edit rate even when all MXF rate fields agree', async () => {
				const data = await readFixture(format);
				setRate(data, 60);
				await expect(configuration(data)).rejects.toThrow(/edit rate/);
			});
			it.each([
				[0x3301, 8, /CDCI/], [0x3302, 1, /CDCI/], [0x3308, class50 ? 1 : 2, /CDCI/],
				[0x320c, 1, /interlaced/], [0x3203, width + 16, /raster/],
			] as const)('should reject contradictory descriptor tag %i', async (tag, value, error) => {
				const data = await readFixture(format);
				const item = descriptorField(data, tag);
				item.writeUIntBE(value, 0, item.length);
				await expect(configuration(data)).rejects.toThrow(error);
			});
			it('should reject clip wrapping', async () => {
				const data = await readFixture(format);
				descriptorField(data, 0x3004)[15] = 2;
				await expect(configuration(data)).rejects.toThrow(/frame wrapping/);
			});
			it('should reject AVC-Intra in OPAtom even with otherwise supported frame wrapping', async () => {
				const data = await readFixture(format);
				for (const klv of klvs(data).filter(x => x.key.startsWith('060e2b34020501010d010201010')
					&& ['02', '03', '04'].includes(x.key.slice(26, 28)))) {
					klv.value.set(Buffer.from('060e2b34040101010d01020110000000', 'hex'), 64);
				}
				await expect(configuration(data)).rejects.toThrow(/AVC-Intra OPAtom/);
			});
		});
		describe('when picture headers contradict the constrained coding label', () => {
			it.each([
				['profile', 14, /SPS profile/], ['Intra constraint', 19, /Intra 10-bit/],
				['level', 31, /prescribed level/], ['chroma', 35, /progressive.*4:2:/],
				['transform bypass', 42, /transform bypass/],
				['9-bit luma', 38, /Intra 10-bit/], ['9-bit chroma', 41, /progressive.*4:2:/],
				['field-coded SPS', class50 ? (height === 720 ? 341 : 345) : (height === 720 ? 433 : 341),
					/progressive.*4:2:/],
				['SPS raster', class50 ? (height === 720 ? 329 : 331) : (height === 720 ? 421 : 327), /SPS geometry/],
			] as const)('should reject %s', async (name, bit, error) => {
				const data = await readFixture(format);
				// Bit positions from FFmpeg trace_headers, including the NAL header, excluding EPBs.
				if (class50 && name === 'field-coded SPS') {
					// frame_mbs_only_flag = 0 introduces mb_adaptive_frame_field_flag.
					replaceSpsBits(data, bit, 1, '00');
				} else {
					flipSpsBit(data, bit);
				}
				await expect(configuration(data)).rejects.toThrow(error);
			});
			it.each([[0, 7], [3, 7], [3, 8]])('should reject frame %i missing NAL type %i', async (frame, type) => {
				const data = await readFixture(format);
				nal(data, frame, type)[0] = 12;
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getKeyPacket(frame / rate)).rejects.toThrow(/requires in-band SPS\/PPS/);
			});
			it('should reject changed PPS on a cold late seek', async () => {
				const data = await readFixture(format);
				nal(data, 3, 8)[2]! ^= 1;
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getKeyPacket(Infinity)).rejects.toThrow(/stable parameter sets/);
			});
			it('should reject a non-IDR slice among the picture slices', async () => {
				const data = await readFixture(format);
				nal(data, 3, 5)[0] = 0x61;
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getKeyPacket(Infinity)).rejects.toThrow(/IDR/);
			});
			it('should reject a short access unit before reading its payload', async () => {
				const data = await readFixture(format);
				data.writeUIntBE(size - 512, pictureKlvs(data)[3]!.start + 17, 3);
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getKeyPacket(Infinity, { metadataOnly: true }))
					.rejects.toThrow(/complete fixed-size/);
			});
			it('should reject five-byte BER frame wrapping', async () => {
				const data = await readFixture(format);
				const start = pictureKlvs(data)[3]!.start;
				data[start + 16] = 0x84;
				data.writeUInt32BE(size - 1, start + 17);
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getKeyPacket(Infinity, { metadataOnly: true })).rejects.toThrow(/four-byte BER/);
			});
		});
		describe('when a CBE index cannot address complete pictures', () => {
			it.each([
				['temporal picture delta', 0x3f09, 14, 255, /supported index/],
				['wrong picture delta', 0x3f09, 18, 0, /supported index/],
				['sliced CBE', 0x3f08, 0, 1, /ordinary.*CBE/],
				['different-sized first unit', 0x3f0d, 7, 1, /ordinary.*CBE/],
			] as const)('should reject %s without scanning', async (_, tag, offset, value, error) => {
				const data = await readFixture(format);
				indexField(data, tag)[offset] = value;
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getFirstPacket({ metadataOnly: true })).rejects.toThrow(error);
			});
			it('should reject an edit-unit byte count that mistakes payload size for package size', async () => {
				const data = await readFixture(format);
				indexField(data, 0x3f05).writeUInt32BE(size);
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getFirstPacket({ metadataOnly: true })).rejects.toThrow(/exceeds edit unit/);
			});
		});
	});

describe('given AVC-Intra100 descriptor variants permitted by the mapping', () => {
	describe('when stored height describes visible 1080 lines rather than the coded macroblock height', () => {
		it('should retain the same visible decoder geometry', async () => {
			const data = await readFixture('100-1080p25');
			descriptorField(data, 0x3202).writeUInt32BE(1080);
			expect(await configuration(data))
				.toMatchObject({ codec: 'avc1.7a1029', codedWidth: 1920, codedHeight: 1080 });
		});
	});
	describe('when the coding UL uses the published registry version', () => {
		it('should admit the same Class 100 coding leaf', async () => {
			const data = await readFixture('100-720p50');
			descriptorField(data, 0x3201)[7] = 0x0d;
			expect((await configuration(data))!.codec).toBe('avc1.7a1029');
		});
	});
});

describe.each([
	['720p50', 960, 720, 1280, 346],
	['1080p25', 1440, 1080, 1920, 358],
] as const)('given AVC-Intra50 %s descriptor and SPS geometry', (format, width, height, displayWidth, sarBit) => {
	describe('when all descriptor widths use the documented BMX full-raster form', () => {
		it.each(height === 1080 ? [1080, 1088] : [720])(
			'should expose the coded raster and 16:9 presentation with stored height %i', async (storedHeight) => {
				const data = await readFixture(`50-${format}`);
				// Controlled metadata variant, not a claim of an independently muxed BMX fixture.
				for (const tag of [0x3203, 0x3205, 0x3209]) {
					descriptorField(data, tag).writeUInt32BE(displayWidth);
				}
				descriptorField(data, 0x3202).writeUInt32BE(storedHeight);
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const track = (await input.getPrimaryVideoTrack())!;
				expect([await track.getCodedWidth(), await track.getCodedHeight(),
					await track.getDisplayWidth(), await track.getDisplayHeight()])
					.toEqual([width, height, displayWidth, height]);
				expect(await track.getDecoderConfig()).toMatchObject({
					codedWidth: width, codedHeight: height, displayAspectWidth: 16, displayAspectHeight: 9,
				});
			},
		);
	});
	describe('when metadata mixes raster forms or disagrees with the in-band aspect', () => {
		it.each([
			[0x3203, displayWidth], [0x3205, displayWidth], [0x3209, width - 16],
			[0x3204, height - 16], [0x3206, 1], [0x3207, 1], [0x320a, 1], [0x320b, 1],
			[0x3204, height + 1], [0x3204, height + 16], [0x3205, width + 16],
		])('should reject incoherent descriptor field %i', async (tag, value) => {
			const data = await readFixture(`50-${format}`);
			descriptorField(data, tag).writeUInt32BE(value);
			await expect(configuration(data)).rejects.toThrow(/raster|cropped/);
		});
		it('should reject a contradictory descriptor aspect rather than stretching the picture', async () => {
			const data = await readFixture(`50-${format}`);
			descriptorField(data, 0x320e).writeUInt32BE(4);
			descriptorField(data, 0x320e).writeUInt32BE(3, 4);
			await expect(configuration(data)).rejects.toThrow(/aspect ratio/);
		});
		it('should reject an explicit SPS SAR that disagrees with the descriptor', async () => {
			const data = await readFixture(`50-${format}`);
			flipSpsBit(data, sarBit + 7); // aspect_ratio_idc 14 (4:3) becomes 15 (3:2).
			await expect(configuration(data)).rejects.toThrow(/SPS aspect ratio/);
		});
		it('should use the descriptor aspect when the SPS leaves SAR unspecified', async () => {
			const data = await readFixture(`50-${format}`);
			replaceSpsBits(data, sarBit, 8, '00000000');
			expect(await configuration(data)).toMatchObject({
				codedWidth: width, codedHeight: height, displayAspectWidth: 16, displayAspectHeight: 9,
			});
		});
	});
	describe('when the SPS declares reference pictures in an Intra profile', () => {
		it('should reject nonzero max_num_ref_frames without misparsing later SPS fields', async () => {
			const data = await readFixture(`50-${format}`);
			replaceSpsBits(data, 317, 1, '010'); // max_num_ref_frames = 1 instead of 0.
			await expect(configuration(data)).rejects.toThrow(/Intra.*reference frames/);
		});
	});
	describe('when constraints and level describe a different operating point', () => {
		it('should admit the progressive-only Intra constraint and published registry version', async () => {
			const data = await readFixture(`50-${format}`);
			nal(data, 0, 7)[2] = 0x18;
			descriptorField(data, 0x3201)[7] = 0x0d;
			expect(await configuration(data)).toMatchObject({ codec: height === 720 ? 'avc1.6e1820' : 'avc1.6e1828' });
		});
		it('should require the prescribed level at 50 fps rather than using Class 100 levels', async () => {
			const data = await readFixture(`50-${format}`);
			setRate(data, 50);
			nal(data, 0, 7)[3] = 41;
			await expect(configuration(data)).rejects.toThrow(/prescribed level/);
			nal(data, 0, 7)[3] = height === 720 ? 32 : 42;
			expect(await configuration(data)).toMatchObject({ codec: height === 720 ? 'avc1.6e1020' : 'avc1.6e102a' });
		});
		it('should reject an unindexed Class 50 file instead of scanning', async () => {
			const data = await readFixture(`50-${format}`);
			const essenceData = klvs(data).find(x => x.key === '060e2b34025301010d01010101012300')!;
			localFields(essenceData.value).get(0x3f06)!.writeUInt32BE(0);
			await expect(configuration(data)).rejects.toThrow(/AVC-Intra requires an index/);
		});
	});
});

describe.each([1440, 1920])('given AVC-Intra50 1080p25 with descriptor width %i', (width) => {
	describe('when sampled and display heights distinguish compression padding', () => {
		it.each([
			[1080, undefined], [1088, 1080], [undefined, 1080],
		])('should present 1080 lines with sampled height %s and display height %s', async (sampled, display) => {
			const data = await readFixture('50-1080p25');
			for (const tag of [0x3203, 0x3205, 0x3209]) {
				descriptorField(data, tag).writeUInt32BE(width);
			}
			for (const [tag, value] of [[0x3204, sampled], [0x3208, display]] as const) {
				if (value === undefined) {
					omitDescriptorField(data, tag);
				} else {
					descriptorField(data, tag).writeUInt32BE(value);
				}
			}
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const track = (await input.getPrimaryVideoTrack())!;
			expect([await track.getCodedWidth(), await track.getCodedHeight(),
				await track.getDisplayWidth(), await track.getDisplayHeight()])
				.toEqual([1440, 1080, 1920, 1080]);
			expect(await track.getDecoderConfig()).toMatchObject({
				codec: 'avc1.6e1028', codedWidth: 1440, codedHeight: 1080,
				displayAspectWidth: 16, displayAspectHeight: 9,
			});
		});
		it('should reject sampled padding that exceeds the stored height', async () => {
			const data = await readFixture('50-1080p25');
			for (const tag of [0x3203, 0x3205, 0x3209]) {
				descriptorField(data, tag).writeUInt32BE(width);
			}
			descriptorField(data, 0x3202).writeUInt32BE(1080);
			descriptorField(data, 0x3204).writeUInt32BE(1088);
			await expect(configuration(data)).rejects.toThrow(/raster/);
		});
	});
});

describe('given AVC-Intra100 without the requirements for the declared operating point', () => {
	describe('when 1080p50 is declared but the SPS only signals Level 4.1', () => {
		it('should reject the inconsistent level rather than treating all progressive rates alike', async () => {
			const data = await readFixture('100-1080p25');
			setRate(data, 50);
			await expect(configuration(data)).rejects.toThrow(/prescribed level/);
		});
	});
	describe('when the essence has no associated index', () => {
		it('should reject the mapping instead of selecting a scan fallback', async () => {
			const data = await readFixture('100-720p50');
			const essenceData = klvs(data).find(x => x.key === '060e2b34025301010d01010101012300')!;
			localFields(essenceData.value).get(0x3f06)!.writeUInt32BE(0);
			await expect(configuration(data)).rejects.toThrow(/AVC-Intra requires an index/);
		});
	});
});

describe('given an AVC-Intra50 SPS with extra cropping', () => {
	describe('when the visible dimensions still match the descriptor', () => {
		it('should reject a wider coded raster cropped down to 1440', async () => {
			const data = await readFixture('50-1080p25');
			replaceSpsBits(data, 349, 1, '0001001'); // Crop 16 luma samples from the right.
			replaceSpsBits(data, 319, 13, '0000001011011'); // 91 macroblocks instead of 90.
			await expect(configuration(data)).rejects.toThrow(/SPS coded raster/);
		});
		it('should reject top cropping instead of the prescribed bottom padding', async () => {
			const data = await readFixture('50-1080p25');
			replaceSpsBits(data, 350, 6, '001011'); // Move the eight cropped lines from bottom to top.
			await expect(configuration(data)).rejects.toThrow(/SPS coded raster/);
		});
	});
});
