import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Input, InputDisposedError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, CustomSource } from '../../src/source.js';

// Unmodified FFmpeg 7.1.1 mxf_d10 output, with authored black and 48 kHz signed little-endian PCM.
// Video: -f lavfi -i color=c=black:s=720x608:r=25 (PAL), or 720x512:r=30000/1001 (NTSC).
// -c:v mpeg2video -pix_fmt yuv422p -b:v 30M -minrate 30M -maxrate 30M -bufsize 1200000
// -rc_init_occupancy 1200000 -g 1 -bf 0 -flags +ildct+ilme -vf setfield=tff -intra_vlc 1
// -non_linear_quant 1 -qmax 28 -dc 10 -ps 1 -f mxf_d10; -c:a pcm_s16le or pcm_s24le.
// PAL: 4:3, three frames, 16-bit/4ch. NTSC: 16:9, five frames, 24-bit/8ch.
// Inactive: PAL 4:3, one frame, 24-bit/2ch input with -d10_channelcount 4.
// PCM recipe, zero-based sample n/channel c, L=2^(bits-1): when n%64<16, use entry (n%64+3*c)%16
// of [0,1,-1,L-1,-L,L-2,-L+1,4660,-4660,257,-257,85,-85,7,-7,42]; otherwise
// ((n*257+c*65537+c*n*17) % (2*L))-L. Hashes below were checked against independent FFmpeg decoding.
const readFixture = (name = '16bit-pal') => readFile(new URL(`../public/mxf-aes3-${name}.mxf`, import.meta.url));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const klvs = (data: Buffer) => {
	const result: { key: string; start: number; offset: number; value: Buffer }[] = [];
	for (let start = 0; start < data.length;) {
		const first = data[start + 16]!;
		const count = first & 128 ? first & 127 : 0;
		const size = count ? data.readUIntBE(start + 17, count) : first;
		const offset = start + 17 + count;
		result.push({ key: data.subarray(start, start + 16).toString('hex'), start, offset,
			value: data.subarray(offset, offset + size) });
		start = offset + size;
	}
	return result;
};
const audioKlvs = (data: Buffer) => klvs(data).filter(x => x.key === '060e2b34010201010d01030106011000');
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
const replaceValue = (data: Buffer, key: string, value: Buffer) => {
	const items = klvs(data);
	const index = items.findIndex(x => x.key === key);
	const item = items[index]!;
	const fill = items.slice(index + 1).find(x => x.key === '060e2b34010101020301021001000000')!;
	const header = Buffer.alloc(20);
	header.set(Buffer.from(key, 'hex'));
	header[16] = 0x83;
	header.writeUIntBE(value.length, 17, 3);
	const content = Buffer.concat([header, value, data.subarray(item.offset + item.value.length, fill.start)]);
	const end = fill.offset + fill.value.length;
	const padding = end - item.start - content.length;
	expect(padding).toBeGreaterThanOrEqual(20);
	const tail = Buffer.alloc(padding);
	tail.set(Buffer.from(fill.key, 'hex'));
	tail[16] = 0x83;
	tail.writeUIntBE(padding - 20, 17, 3);
	data.set(Buffer.concat([content, tail]), item.start);
};
const audioProperty = (data: Buffer, tag: number, ul: string, value: Buffer) => {
	const primerKey = '060e2b34020501010d01020101050100';
	const primer = klvs(data).find(x => x.key === primerKey)!.value;
	if (primer.indexOf(Buffer.from(ul, 'hex')) === -1) {
		const entry = Buffer.alloc(18);
		entry.writeUInt16BE(tag);
		entry.set(Buffer.from(ul, 'hex'), 2);
		const updated = Buffer.concat([primer, entry]);
		updated.writeUInt32BE(primer.readUInt32BE(0) + 1);
		replaceValue(data, primerKey, updated);
	}
	const key = '060e2b34025301010d01010101014200';
	const descriptor = klvs(data).find(x => x.key === key)!.value;
	const item = Buffer.alloc(4);
	item.writeUInt16BE(tag);
	item.writeUInt16BE(value.length, 2);
	replaceValue(data, key, Buffer.concat([descriptor, item, value]));
};
const batch = (count: number, size: number) => {
	const data = Buffer.alloc(8 + count * size);
	data.writeUInt32BE(count);
	data.writeUInt32BE(size, 4);
	return data;
};

describe('given independent D-10 files carrying ST 331 AES3', () => {
	describe('when reading PCM through the public sinks', () => {
		it.each([
			['16bit-pal', 16, 4, [1920, 1920, 1920],
				'b66cd23650766067457c9e39bf5a9138fa20976ca8cb932d3b42a0153492edeb'],
			['24bit-ntsc', 24, 8, [1602, 1601, 1602, 1601, 1602],
				'4e2e034f055918f02fbbbf9d1f78b7f356d00a482713bd8a15c4ca8adf4811c0'],
			['24bit-inactive', 24, 4, [1920], '0502ca7c13d0c14da21f6289e93fa4e739fc3c4aa78fc47f3c7d3efe1bfa5c9c'],
		] as const)('should unpack %s with exact PCM bytes, channel order and sample timing', async (
			name, bits, channels, counts, expectedHash,
		) => {
			using input = new Input({ source: new BufferSource(await readFixture(name)), formats: ALL_FORMATS });
			expect((await input.getTracks()).map(t => t.type)).toEqual(['video', 'audio']);
			const track = (await input.getPrimaryAudioTrack())!;
			expect(await track.getDecoderConfig()).toEqual({ codec: `pcm-s${bits}`, sampleRate: 48000,
				numberOfChannels: channels });
			const sink = new EncodedPacketSink(track);
			const pcm = createHash('sha256');
			let total = 0;
			let index = 0;
			for await (const packet of sink.packets()) {
				const count = counts[index]!;
				expect([packet.timestamp, packet.duration, packet.byteLength, packet.data.length])
					.toEqual([total / 48000, count / 48000, count * channels * bits / 8, count * channels * bits / 8]);
				const metadata = (await sink.getPacket(packet.timestamp, { metadataOnly: true }))!;
				expect([metadata.timestamp, metadata.duration, metadata.byteLength, metadata.sequenceNumber])
					.toEqual([packet.timestamp, packet.duration, packet.byteLength, index]);
				expect(metadata.data.length).toBe(0);
				pcm.update(packet.data);
				total += count;
				index++;
			}
			expect(index).toBe(counts.length);
			expect(pcm.digest('hex')).toBe(expectedHash);
			let decoded = 0;
			const decodedPcm = createHash('sha256');
			for await (using sample of new AudioSampleSink(track).samples()) {
				const values = new Float32Array(sample.numberOfFrames * channels);
				sample.copyTo(values, { planeIndex: 0, format: 'f32' });
				const integers = Buffer.alloc(values.length * bits / 8);
				for (const [i, value] of values.entries()) {
					integers.writeIntLE(value * 2 ** (bits - 1), i * bits / 8, bits / 8);
				}
				decodedPcm.update(integers);
				decoded += sample.numberOfFrames;
			}
			expect(decoded).toBe(total);
			expect(decodedPcm.digest('hex')).toBe(expectedHash);
		});
	});

	describe('when accessing the undecodable picture track', () => {
		it.each([
			['16bit-pal', 608, 768, 576, 150000, 'd92c7edb6c7f07457eb8e69f60dece0e60d714341449080c69af787891a3a583'],
			['24bit-ntsc', 512, 864, 486, 125125, '2d95beb074247afd0d93fe0a09a7a7c04eba925019168cabfbc8a3a99903271c'],
		] as const)('should expose honest %s geometry and unchanged picture packets', async (
			name, height, displayWidth, displayHeight, size, expectedHash,
		) => {
			using input = new Input({ source: new BufferSource(await readFixture(name)), formats: ALL_FORMATS });
			const video = (await input.getPrimaryVideoTrack())!;
			expect(await video.getCodec()).toBeNull();
			expect(await video.getDecoderConfig()).toBeNull();
			expect(await video.canDecode()).toBe(false);
			expect(await video.getColorSpace()).toEqual({});
			expect([await video.getCodedWidth(), await video.getCodedHeight(),
				await video.getSquarePixelWidth(), await video.getSquarePixelHeight(),
				await video.getDisplayWidth(), await video.getDisplayHeight()])
				.toEqual([720, height, displayWidth, height, displayWidth, displayHeight]);
			const hashes = name === '16bit-pal'
				? [expectedHash,
						'd89bfb604f32b7ae553000616b07d7482ffe167af0fd15bdf92469dcd9ee25ea',
						'13e9c4a62a34f17d53e622ae00aec89aa643f7b1e9e5df7f984fdf19236fcf32']
				: [expectedHash,
						'8b6e86a2c46186f65fb90b620931c2b90068bfded00675612169e59749aaa57b',
						'2597685659df758f499d19858f323ff4ebac99ae7fa1b60fa9fac0db0823b8d2',
						'e2b5b190d19125a49f52f94214cdc1a266fdea8ed37d821f1325efda326eb580',
						'5552a060f716db56bfb9cfd50da668ecb1b21bd40f19329feb90f4b32b4fc7ad'];
			let index = 0;
			for await (const packet of new EncodedPacketSink(video).packets()) {
				expect([packet.byteLength, packet.type, packet.timestamp, packet.duration])
					.toEqual([size, 'key', name === '16bit-pal' ? index / 25 : index * 1001 / 30000,
						name === '16bit-pal' ? 1 / 25 : 1001 / 30000]);
				expect(hash(packet.data)).toBe(hashes[index++]);
			}
			expect(index).toBe(hashes.length);
		});
	});

	describe('when ST 331 packet headers are unsupported or malformed', () => {
		it.each([
			[0, 128, /usable F\/V\/U\/C\/P/], [0, 8, /reserved/], [0, 6, /sequence/],
			[1, 0, /sample count|length/], [3, 255, /declared channels/],
		] as const)('should reject header byte %i value %i during metadata reads', async (byte, value, error) => {
			const data = await readFixture();
			audioKlvs(data)[0]!.value[byte] = value;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			await expect(sink.getFirstPacket({ metadataOnly: true })).rejects.toThrow(error);
		});
		it.each(['zero samples', 'count versus length', 'truncated length'])(
			'should reject %s without treating raw packet length as PCM bytes', async (fault) => {
				const data = await readFixture('24bit-ntsc');
				const raw = audioKlvs(data)[0]!;
				if (fault === 'truncated length') {
					data.writeUIntBE(raw.value.length - 1, raw.start + 17, 3);
				} else {
					raw.value.writeUInt16LE(fault === 'zero samples' ? 0 : 1601, 1);
				}
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
				await expect(sink.getFirstPacket({ metadataOnly: true }))
					.rejects.toThrow(/sample count|payload length/);
			},
		);
		it('should reject an incorrect ID in a valid slot before returning any samples', async () => {
			const data = await readFixture();
			const audio = audioKlvs(data)[0]!.value;
			audio[audio.length - 32] = 7;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			expect((await sink.getFirstPacket({ metadataOnly: true }))!.byteLength).toBe(15360);
			await expect(sink.getFirstPacket()).rejects.toThrow(/slot channel ID/);
		});
		it('should preserve sparse channels and ignore inactive slots and unusable status bits', async () => {
			const data = await readFixture();
			const audio = audioKlvs(data)[0]!.value;
			audio[3] = 5;
			for (let i = 4; i < audio.length; i += 32) {
				for (let channel = 0; channel < 8; channel++) {
					const offset = i + channel * 4;
					audio.writeUInt32LE(channel === 0 || channel === 2
						? (audio.readUInt32LE(offset) | 0xf0000008) >>> 0
						: 0xffffffff, offset);
				}
			}
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const packet = (await new EncodedPacketSink((await input.getPrimaryAudioTrack())!).getFirstPacket())!;
			expect([...new Int16Array(packet.data.buffer, packet.data.byteOffset, 8)])
				.toEqual([0, 0, -32767, 0, 1, 0, 4660, 0]);
		});
		it.each([0, 1, 2, 3, 4, 5])('should time by samples, not sequence counter %i', async (sequence) => {
			const data = await readFixture('24bit-ntsc');
			audioKlvs(data)[0]!.value[0] = sequence;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			const first = (await sink.getFirstPacket())!;
			const next = (await sink.getNextPacket(first))!;
			expect([first.duration, next.timestamp, next.duration]).toEqual([1602 / 48000, 1602 / 48000, 1601 / 48000]);
		});
	});

	describe('when descriptor metadata declares audio or non-audio', () => {
		it.each([
			['060e2b340401010a0402020101000000', true],
			['060e2b34040101010402020101000000', true],
			['060e2b3404010101040202017f000000', true],
			['060e2b34040101010402020203021c00', false],
			['060e2b34040101010402020203020100', false],
			['', false],
		] as const)('should honor SoundEssenceCoding %s', async (coding, pcm) => {
			const data = await readFixture();
			audioProperty(data, 0x3d06, '060e2b34010101020402040200000000', Buffer.from(coding, 'hex'));
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			if (pcm) {
				expect(await (await input.getPrimaryAudioTrack())!.getCodec()).toBe('pcm-s16');
			} else {
				await expect(input.getTracks()).rejects.toThrow(/sound coding/);
			}
		});
		it('should not use fixed PCM status to admit usable in-band F/V/U/C/P', async () => {
			const data = await readFixture();
			const modes = batch(4, 1);
			modes.fill(3, 8);
			audioProperty(data, 0x3d10, '060e2b34010101050402050102000000', modes);
			audioProperty(data, 0x3d11, '060e2b34010101050402050103000000', batch(4, 24));
			audioKlvs(data)[0]!.value[0] = 128;
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			await expect(sink.getFirstPacket()).rejects.toThrow(/usable F\/V\/U\/C\/P/);
		});
		it.each([0, 1, 2, 3, 4, 5])('should enforce channel status mode %i', async (mode) => {
			const data = await readFixture();
			const modes = batch(4, 1);
			modes.fill(mode, 8);
			audioProperty(data, 0x3d10, '060e2b34010101050402050102000000', modes);
			if (mode === 3) {
				audioProperty(data, 0x3d11, '060e2b34010101050402050103000000', batch(4, 24));
			}
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			if (mode <= 3) {
				const packet = await new EncodedPacketSink((await input.getPrimaryAudioTrack())!).getFirstPacket();
				expect(hash(packet!.data)).toBe('5272e238ac602a79e094e50cc6bdec6b6d82dd6211c64bdf16a1d443fa4405ea');
			} else {
				await expect(input.getTracks()).rejects.toThrow(/channel status mode/);
			}
		});
		it.each(['non-audio', 'missing', 'wrong count', 'block offset'])(
			'should reject %s fixed channel status metadata', async (fault) => {
				const data = await readFixture();
				const modes = batch(4, 1);
				modes[11] = 3;
				audioProperty(data, 0x3d10, '060e2b34010101050402050102000000', modes);
				if (fault !== 'missing') {
					const fixed = batch(fault === 'wrong count' ? 3 : 4, 24);
					if (fault === 'non-audio') {
						fixed[80] = 2;
					}
					audioProperty(data, 0x3d11, '060e2b34010101050402050103000000', fixed);
				}
				if (fault === 'block offset') {
					audioProperty(data, 0x3d0f, '060e2b34010101050402030203000000', Buffer.from([0, 192]));
				}
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				await expect(input.getTracks())
					.rejects.toThrow(/AES3 (fixed channel status|block start|non-audio)|missing AES3/);
			},
		);
	});

	describe('when recognizable ST 337 non-PCM bursts cross packet boundaries', () => {
		it.each([1, 31])('should reject non-Dolby-E data type %i inside a packet', async (type) => {
			const data = await readFixture();
			const raw = audioKlvs(data)[0]!.value;
			for (const [i, value] of [0xf872, 0x4e1f, type, 256].entries()) {
				raw.writeUInt32LE(value << 12, 4 + (100 + i) * 32);
			}
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			await expect(sink.getFirstPacket()).rejects.toThrow(`ST 337 non-PCM burst (data type ${type})`);
		});
		it.each([16, 20, 24])('should reject %i-bit preambles on either side of the boundary', async (bits) => {
			for (const split of [0, 1, 2, 3]) {
				const data = await readFixture('24bit-ntsc');
				const packets = audioKlvs(data);
				const frameMode = split === 0;
				const start = 1602 - (frameMode ? 1 : split);
				const preamble = bits === 16
					? [0xf872, 0x4e1f]
					: bits === 20 ? [0x6f872, 0x54e1f] : [0x96f872, 0xa54e1f];
				preamble.push((28 | ((bits - 16) / 4) << 5) << (bits - 16), 256);
				for (const [i, value] of preamble.entries()) {
					const sample = start + (frameMode ? Math.floor(i / 2) : i);
					const channel = frameMode ? i % 2 : 2;
					const packet = packets[sample < 1602 ? 0 : 1]!.value;
					packet.writeUInt32LE(((value << (28 - bits)) | channel) >>> 0,
						4 + (sample < 1602 ? sample : sample - 1602) * 32 + channel * 4);
				}
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
				const metadata = (await sink.getFirstPacket({ metadataOnly: true }))!;
				await expect(sink.getFirstPacket()).rejects.toThrow(/ST 337 non-PCM burst.*Dolby E/);
				await expect(sink.getNextPacket(metadata)).rejects.toThrow(/ST 337 non-PCM burst.*Dolby E/);
			}
		});
	});

	describe('when descriptors fall outside the admitted D-10 subset', () => {
		it.each([
			['4200', 0x3d07, 2, /D-10 AES3/], ['4200', 0x3d01, 32, /D-10 AES3/],
			['4200', 0x3d02, 0, /D-10 AES3/], ['2800', 0x320c, 0, /geometry/],
			['2800', 0x3208, 240, /geometry/], ['2800', 0x3217, 1, /geometry/],
		] as const)('should reject descriptor %s tag %i value %i', async (kind, tag, value, error) => {
			const data = await readFixture();
			const item = field(data, kind, tag);
			item.writeUIntBE(value, 0, item.length);
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			await expect(input.getTracks()).rejects.toThrow(error);
		});
		it.each(['coding', 'extended', 'picture-only', 'unknown'])(
			'should not swallow an unsupported %s picture track', async (fault) => {
				const data = await readFixture();
				const item = field(data, '2800', fault === 'coding' ? 0x3201 : 0x3004);
				item[15] = fault === 'coding' ? 6 : fault === 'extended' ? 2 : fault === 'picture-only' ? 127 : 255;
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				await expect(input.getTracks()).rejects.toThrow(/picture coding|picture descriptor/);
			},
		);
		it.each([['16bit-pal', 16, 9, 1024, 576], ['24bit-ntsc', 4, 3, 648, 486]] as const)(
			'should preserve %s alternate display aspect ratio', async (name, n, d, w, h) => {
				const data = await readFixture(name);
				const aspect = field(data, '2800', 0x320e);
				aspect.writeUInt32BE(n);
				aspect.writeUInt32BE(d, 4);
				using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
				const video = (await input.getPrimaryVideoTrack())!;
				expect([await video.getDisplayWidth(), await video.getDisplayHeight()]).toEqual([w, h]);
			},
		);
	});

	describe('when seeking and reading concurrently', () => {
		it('should match nonzero essence element numbers to their declared TrackNumber', async () => {
			const data = await readFixture();
			for (const prefix of ['050101', '060110']) {
				const number = Buffer.from(`${prefix}00`, 'hex');
				const track = klvs(data).find(x => x.key === '060e2b34025301010d01010101013b00'
					&& x.value.indexOf(number) !== -1)!;
				track.value[track.value.indexOf(number) + 3] = 7;
				for (const essence of klvs(data).filter(x => x.key === `060e2b34010201010d010301${prefix}00`)) {
					data[essence.start + 15] = 7;
				}
			}
			using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
			const packets = await Promise.all((await input.getTracks())
				.map(t => new EncodedPacketSink(t).getFirstPacket()));
			expect(packets.map(p => p!.byteLength)).toEqual([150000, 15360]);
			expect(hash(packets[1]!.data)).toBe('5272e238ac602a79e094e50cc6bdec6b6d82dd6211c64bdf16a1d443fa4405ea');
		});
		it('should retain normalized packet ownership and a sample-accurate fractional cold seek', async () => {
			using input = new Input({
				source: new BufferSource(await readFixture('24bit-ntsc')), formats: ALL_FORMATS,
			});
			const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			const video = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const [last, first, picture] = await Promise.all([
				audio.getPacket(Infinity), audio.getFirstPacket({ metadataOnly: true }), video.getFirstPacket(),
			]);
			expect([last!.timestamp, last!.byteLength, first!.byteLength]).toEqual([6406 / 48000, 38448, 38448]);
			expect((await audio.getNextPacket(first!))!.timestamp).toBe(1602 / 48000);
			await expect(audio.getNextPacket(picture!)).rejects.toThrow(/does not belong/);
			await expect(video.getNextPacket(last!)).rejects.toThrow(/does not belong/);
			expect(await audio.getNextPacket(last!)).toBeNull();
		});
		it('should preserve packets across concurrent indexed first and last PAL reads', async () => {
			const data = await readFixture();
			const raw = audioKlvs(data);
			const gate = () => {
				let open!: () => void;
				const promise = new Promise<void>((resolve) => {
					open = resolve;
				});
				return { promise, open };
			};
			const firstReading = gate();
			const lastReading = gate();
			const releasePayloads = gate();
			const neighborReading = gate();
			const releaseNeighbor = gate();
			const reads: [number, number][] = [];
			using input = new Input({ source: new CustomSource({ getSize: () => data.length, prefetchProfile: 'none',
				read: async (start, end) => {
					reads.push([start, end]);
					for (const [i, reading] of [[0, firstReading], [2, lastReading]] as const) {
						if (start < raw[i]!.offset + raw[i]!.value.length && end > raw[i]!.offset + 5) {
							reading.open();
							await releasePayloads.promise;
						}
					}
					if (start < raw[1]!.offset + 4 && end > raw[1]!.offset) {
						neighborReading.open();
						await releaseNeighbor.promise;
					}
					return data.subarray(start, end);
				} }), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			let completed = 0;
			const first = sink.getFirstPacket().then((packet) => {
				completed++;
				return packet!;
			});
			const last = sink.getPacket(Infinity).then((packet) => {
				completed++;
				return packet!;
			});
			try {
				const metadata = await Promise.all([
					sink.getFirstPacket({ metadataOnly: true }), sink.getPacket(Infinity, { metadataOnly: true }),
				]);
				await Promise.all([firstReading.promise, lastReading.promise]);
				// A sequential locator would have visited the middle audio element before returning the last.
				expect(reads.filter(([start, end]) => start < raw[1]!.offset + raw[1]!.value.length
					&& end > raw[1]!.start)).toEqual([]);
				releasePayloads.open();
				await neighborReading.promise;
				expect(completed).toBe(0);
				releaseNeighbor.open();
				const packets = await Promise.all([first, last]);
				for (const [i, packet] of packets.entries()) {
					const identity = [packet.timestamp, packet.duration, packet.byteLength, packet.sequenceNumber];
					expect(identity).toEqual([i * 0.08, 0.04, 15360, i * 2]);
					expect([metadata[i]!.timestamp, metadata[i]!.duration,
						metadata[i]!.byteLength, metadata[i]!.sequenceNumber]).toEqual(identity);
					expect(metadata[i]!.data.length).toBe(0);
					expect(packet.data.length).toBe(15360);
				}
				expect(packets.map(p => hash(p.data))).toEqual([
					'5272e238ac602a79e094e50cc6bdec6b6d82dd6211c64bdf16a1d443fa4405ea',
					'0fa9fe80e924e1293bb2827eeea4513f3f72dd26b06f03f97e2c06741764933f',
				]);
				// CustomSource may coalesce the middle audio's header/head/tail reads, but never needs pictures.
				for (const picture of klvs(data).filter(x => x.key === '060e2b34010201010d01030105010100')) {
					expect(reads.filter(([start, end]) => start < picture.offset + picture.value.length
						&& end > picture.offset + 5)).toEqual([]);
				}
				expect(reads.reduce((bytes, [start, end]) => bytes + end - start, 0)).toBeLessThan(256 * 1024);
				const middle = (await sink.getNextPacket(metadata[0]!))!;
				expect([middle.timestamp, middle.duration, middle.sequenceNumber]).toEqual([0.04, 0.04, 1]);
				expect(hash(middle.data)).toBe('ae20165eda0012c90a35833dad6cb37f902761369c4619f8269ff91375f6c699');
				expect(hash((await sink.getNextPacket(middle))!.data)).toBe(hash(packets[1].data));
				expect(await sink.getNextPacket(metadata[1]!)).toBeNull();
			} finally {
				releasePayloads.open();
				releaseNeighbor.open();
			}
		});
		it('should reject a pending normalized read when the input is disposed', async () => {
			const data = await readFixture();
			const raw = audioKlvs(data)[0]!;
			let release!: () => void;
			let started!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			using input = new Input({ source: new CustomSource({ getSize: () => data.length, prefetchProfile: 'none',
				read: async (start, end) => {
					if (start < raw.offset + raw.value.length && end > raw.offset + 5) {
						started();
						await pending;
					}
					return data.subarray(start, end);
				} }), formats: ALL_FORMATS });
			const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			const result = expect(sink.getFirstPacket()).rejects.toBeInstanceOf(InputDisposedError);
			await reading;
			input.dispose();
			release();
			await result;
		});
	});
});
