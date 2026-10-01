import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	ALL_FORMATS, Input, MXF, BufferSource, CustomSource, EncodedPacketSink, VideoSampleSink, canDecodeVideo,
	canEncodeVideo, Mp4OutputFormat, CmafOutputFormat, MovOutputFormat, MkvOutputFormat, WebMOutputFormat,
	Output, BufferTarget, EncodedVideoPacketSource,
} from '../../src/index.js';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';

// Original MIT-licensed OpenHTJS a0e1dbbd68e9e4be6beec50abf15ea792fe19f51 patterns, not demo imagery.
// Each 8x4 frame repeats the row below. RGB16 source values are RGB8 values multiplied by 257.
// OpenJPH 0.32.0: reversible, one decomposition, tile, tile-part and layer; RGB8 uses RCT, RGB16 does not.
// OP1a wrappers use five frames at 24 fps. The indexed wrapper has 12 RGB8 frames plus two mono PCM tracks,
// three body partitions and a VBE footer index. Generated with the archived 0af6926d MXF fixture writers,
// correcting partition container labels and reducing indexed count/partition starts to 12/[0,4,8].
// Fixture license is retained in packages/htj2k/README.md. Expected pixels are the authored input pattern.
const readFixture = (name: string) => readFileSync(new URL(`../public/htj2k-${name}`, import.meta.url));
const expectedRow = [
	0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
	0, 0, 255, 255, 17, 83, 201, 255, 128, 64, 32, 255, 254, 1, 127, 255,
];
const expectedRgba = Array.from({ length: 4 }, () => expectedRow).flat();
const colorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true } as const;
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
const frames = (data: Buffer) => klvs(data).filter(x => x.key === '060e2b34010201010d01030115010801');
const field = (data: Buffer, kind: string, tag: number, ordinal = 0) => {
	const set = klvs(data).filter(x => x.key === `060e2b34025301010d0101010101${kind}00`)[ordinal]!;
	for (let i = 0; i < set.value.length;) {
		const size = set.value.readUInt16BE(i + 2);
		if (set.value.readUInt16BE(i) === tag) {
			return set.value.subarray(i + 4, i + 4 + size);
		}
		i += 4 + size;
	}
	throw new Error('Fixture field not found');
};

describe('given complete-frame HTJ2K OP1a input', () => {
	describe('when registering the optional decoder', () => {
		it('should enable decoding without native WebCodecs probing and retry failed WASM initialization', async () => {
			using input = new Input({ source: new BufferSource(readFixture('rgb16.mxf')), formats: ALL_FORMATS });
			expect(await input.getFormat()).toBe(MXF);
			const track = (await input.getPrimaryVideoTrack())!;
			const config = (await track.getDecoderConfig())!;
			expect(config).toEqual({ codec: 'htj2k', codedWidth: 8, codedHeight: 4,
				description: Uint8Array.of(16), colorSpace });
			const nativeProbe = vi.fn(() => {
				throw new Error('Native WebCodecs must not receive HTJ2K');
			});
			vi.stubGlobal('VideoDecoder', { isConfigSupported: nativeProbe });
			try {
				expect(await track.canDecode()).toBe(false);
				expect(await canDecodeVideo('htj2k', config)).toBe(false);
				await expect(new VideoSampleSink(track).getSample(0)).rejects.toThrow(/cannot be decoded/);
				expect(nativeProbe).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
			}
			registerHtj2kDecoder();
			registerHtj2kDecoder();
			expect(await track.canDecode()).toBe(true);
			expect(await canDecodeVideo('htj2k', config)).toBe(true);
			const compilation = vi.spyOn(WebAssembly, 'compile').mockRejectedValueOnce(new Error('WASM unavailable'));
			try {
				await expect(new VideoSampleSink(track).getSample(0)).rejects.toThrow('WASM unavailable');
			} finally {
				compilation.mockRestore();
			}
			using recovered = (await new VideoSampleSink(track).getSample(0))!;
			const rgba = new Uint8Array(recovered.allocationSize());
			await recovered.copyTo(rgba);
			expect([...rgba]).toEqual(expectedRgba);
		});

		it.each(['ArrayBuffer', 'DataView'] as const)(
			'should distinguish %s component depths without memoization collisions', async (format) => {
				registerHtj2kDecoder();
				for (const bits of [12, 16, 12, 8]) {
					const description = format === 'ArrayBuffer'
						? Uint8Array.of(bits).buffer
						: new DataView(Uint8Array.of(0, bits, 0).buffer, 1, 1);
					expect(await canDecodeVideo('htj2k', {
						codedWidth: 8, codedHeight: 4, description, colorSpace,
					})).toBe(bits === 8 || bits === 16);
				}
			});

		it('should not enable encoding or muxing in generic video output formats', async () => {
			expect(await canEncodeVideo('htj2k')).toBe(false);
			for (const format of [new Mp4OutputFormat(), new CmafOutputFormat(),
				new MovOutputFormat(), new MkvOutputFormat(), new WebMOutputFormat()]) {
				expect(format.getSupportedCodecs()).not.toContain('htj2k');
				const output = new Output({ format, target: new BufferTarget() });
				expect(() => output.addVideoTrack(new EncodedVideoPacketSource('htj2k'))).toThrow(/codec/i);
			}
		});

		it.each([
			['missing depth', { description: new Uint8Array() }],
			['oversized axis', { codedWidth: 8193 }],
			['oversized image', { codedWidth: 8192, codedHeight: 4096 }],
			['limited range', { colorSpace: { ...colorSpace, fullRange: false } }],
			['YCbCr', { colorSpace: { ...colorSpace, matrix: 'bt709' as const } }],
		] as const)('should decline %s decoder configurations', async (_name, overrides) => {
			registerHtj2kDecoder();
			expect(await canDecodeVideo('htj2k', {
				codedWidth: 8, codedHeight: 4, description: Uint8Array.of(8), colorSpace, ...overrides,
			})).toBe(false);
		});
	});

	describe('when reading indexed packets', () => {
		it('should discover every track and seek metadata without fetching the requested frame body', async () => {
			const data = readFixture('rgb8-indexed.mxf');
			const reads: [number, number][] = [];
			using input = new Input({ source: new CustomSource({ getSize: () => data.length,
				prefetchProfile: 'none', maxCacheSize: 0, read: (start, end) => {
					reads.push([start, end]);
					return data.subarray(start, end);
				} }), formats: [MXF] });
			expect(await Promise.all((await input.getTracks()).map(track => track.getCodec())))
				.toEqual(['htj2k', 'pcm-s24', 'pcm-s24']);
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.hasOnlyKeyPackets()).toBe(true);
			await track.getDecoderConfig();
			const sink = new EncodedPacketSink(track);
			const meta = (await sink.getPacket(9 / 24, { metadataOnly: true }))!;
			expect([meta.sequenceNumber, meta.timestamp, meta.duration, meta.type, meta.byteLength, meta.data.length])
				.toEqual([9, 9 / 24, 1 / 24, 'key', 219, 0]);
			// The reader's 25-byte KLV probe overlaps five bytes of each four-byte-BER payload.
			const requestedFrame = frames(data)[9]!;
			expect(reads.filter(([start, end]) =>
				end > requestedFrame.offset + 5 && start < requestedFrame.offset + requestedFrame.value.length))
				.toEqual([]);
			expect((await sink.getKeyPacket(9 / 24))!.data).toEqual(new Uint8Array(readFixture('rgb8.j2c')));
			const next = (await sink.getNextPacket(meta))!;
			expect([next.timestamp, next.duration, next.type]).toEqual([10 / 24, 1 / 24, 'key']);
			expect(await track.determinePacketType(next)).toBe('key');
			expect(await track.computeDuration()).toBe(0.5);
		});
	});

	describe('when decoding progressive full-range RGB', () => {
		it('should discard RGB16 low bits without rounding and retain samples across distinct frames', async () => {
			// Original MIT-licensed 8x4 edge pattern. Source RGB16 row, repeated four times:
			// [0,1,127], [128,254,255], [256,257,511], [512,513,65535], [65534,65407,65280],
			// [32767,32768,32769], [255,511,767], [65279,65281,65535]. Phase 1 reverses pixel order.
			// OpenJPH 0.32.0: P6 PPM, maxval 65535, big-endian components; ojph_compress -num_decomps 1
			// -reversible true -colour_trans false -prog_order RPCL -block_size '{64,64}'.
			// The same OP1a writer as the base fixtures wraps five alternating phases at 24 fps, without padding.
			registerHtj2kDecoder();
			using input = new Input({ source: new BufferSource(readFixture('rgb16-edges.mxf')), formats: [MXF] });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			using first = (await sink.getSample(0))!;
			using next = (await sink.getSample(1 / 24))!;
			input.dispose();
			const firstRow = [
				0, 0, 0, 255, 0, 0, 0, 255, 1, 1, 1, 255, 2, 2, 255, 255,
				255, 255, 255, 255, 127, 128, 128, 255, 0, 1, 2, 255, 254, 255, 255, 255,
			];
			const nextRow = [
				254, 255, 255, 255, 0, 1, 2, 255, 127, 128, 128, 255, 255, 255, 255, 255,
				2, 2, 255, 255, 1, 1, 1, 255, 0, 0, 0, 255, 0, 0, 0, 255,
			];
			for (const [sample, row] of [[first, firstRow], [next, nextRow]] as const) {
				const rgba = new Uint8Array(sample.allocationSize());
				await sample.copyTo(rgba);
				expect([...rgba]).toEqual(Array.from({ length: 4 }, () => row).flat());
			}
		});

		it.each([8, 16])('should retain exact owned RGBA8 pixels, color and timing from RGB%i', async (bits) => {
			registerHtj2kDecoder();
			using input = new Input({ source: new BufferSource(readFixture(`rgb${bits}.mxf`)), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			const packets = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				expect(packet.data).toEqual(new Uint8Array(readFixture(`rgb${bits}.j2c`)));
				packets.push([packet.timestamp, packet.duration, packet.type]);
			}
			expect(packets).toEqual([0, 1, 2, 3, 4].map(i => [i / 24, 1 / 24, 'key']));
			const sink = new VideoSampleSink(track);
			using first = (await sink.getSample(0))!;
			using later = (await sink.getSample(2 / 24))!;
			input.dispose();
			const rgba = new Uint8Array(first.allocationSize());
			await first.copyTo(rgba);
			expect([...rgba]).toEqual(expectedRgba);
			expect([first.format, first.codedWidth, first.codedHeight,
				first.timestamp, first.duration, later.timestamp])
				.toEqual(['RGBA', 8, 4, 0, 1 / 24, 2 / 24]);
			expect(first.colorSpace).toMatchObject(colorSpace);
		});
	});

	describe('when descriptor or track mapping is unsupported', () => {
		it.each([
			['RGB layout', 0x3401, '59104710421000000000000000000000', /RGB8 or RGB16/],
			['component minimum', 0x3407, '00000001', /full-range RGB/],
			['component maximum', 0x3406, '000000ff', /full-range RGB/],
			['primaries', 0x3219, '060e2b34040101060401010103040000', /BT.709 RGB/],
			['transfer', 0x3210, '060e2b34040101010401010101010000', /BT.709 RGB/],
			['picture coding', 0x3201, '060e2b340401010d0401020203010100', /HTJ2K picture coding/],
			['wrapping', 0x3004, '060e2b340401010d0d010301020c0700', /frame wrapping/],
			['interlacing', 0x320c, '01', /interlaced/],
			['non-square pixels', 0x320e, '0000001000000009', /HTJ2K requires square pixels/],
			['linked track', 0x3006, '00000002', /descriptor/],
		] as const)('should reject unsupported %s descriptors', async (_name, tag, value, error) => {
			const data = readFixture('rgb16.mxf');
			field(data, '29', tag).set(Buffer.from(value, 'hex'));
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(input.getTracks()).rejects.toThrow(error);
		});

		it('should reject a ProRes essence key on an HTJ2K source track', async () => {
			const data = readFixture('rgb16.mxf');
			field(data, '3b', 0x4804, 1).writeUInt32BE(0x15011700);
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(input.getTracks()).rejects.toThrow('unsupported picture essence key');
		});

		it.each([
			['coding equations', '060e2b34010101020401020101030100', /without coding equations/],
			['sampled crop', '060e2b34010101010401050108000000', /full-frame sampled raster/],
		] as const)('should reject %s in optional descriptor fields', async (_name, ul, error) => {
			const data = readFixture('rgb16.mxf');
			// Reassign the fixture's unknown four-byte optional field through its primer entry.
			const primer = klvs(data).find(x => x.key === '060e2b34020501010d01020101050100')!.value;
			const offset = primer.indexOf(Buffer.from('060e2b340101010e0420040101010000', 'hex'));
			expect(offset).toBeGreaterThan(0);
			primer.set(Buffer.from(ul, 'hex'), offset);
			field(data, '29', 0x8000).writeUInt32BE(7);
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(input.getTracks()).rejects.toThrow(error);
		});

		it('should reject HTJ2K in OPAtom rather than extend the AVC-only mapping', async () => {
			const data = readFixture('rgb16.mxf');
			for (const partition of klvs(data).filter(x => x.key.startsWith('060e2b34020501010d010201010'))) {
				partition.value.set(Buffer.from('060e2b34040101010d01020110000000', 'hex'), 64);
			}
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(input.getTracks()).rejects.toThrow('unsupported OPAtom essence containers');
		});
	});

	describe('when the full-frame codestream is malformed or outside the decoder profile', () => {
		it.each([
			['signed components', 42, 143], ['subsampled components', 43, 2], ['wrong geometry', 11, 9],
			['descriptor depth mismatch', 42, 15], ['truncated EOC', 218, 0], ['multiple tiles', 27, 4],
			['unsupported capabilities', 55, 1], ['multiple quality layers', 68, 2],
			['legacy code blocks', 73, 0], ['irreversible transform', 74, 0], ['quantization', 79, 33],
		] as const)('should reject %s through the sample sink', async (_name, offset, value) => {
			registerHtj2kDecoder();
			const data = readFixture('rgb8.mxf');
			frames(data)[0]!.value[offset] = value;
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(new VideoSampleSink((await input.getPrimaryVideoTrack())!).getSample(0))
				.rejects.toThrow(/HTJ2K/);
		});

		it('should propagate native packet errors and still decode a later valid input', async () => {
			registerHtj2kDecoder();
			const data = readFixture('rgb8.mxf');
			const frame = frames(data)[0]!;
			// Truncate the packet body, not the headers or tile boundaries. Fill preserves partition offsets.
			data.writeUIntBE(129, frame.start + 17, 3);
			frame.value.writeUInt32BE(18, 115);
			frame.value.set([0xff, 0xd9], 127);
			const fill = frame.offset + 129;
			data.set(Buffer.from('060e2b3401010102030102100100000083', 'hex'), fill);
			data.writeUIntBE(frame.value.length - 129 - 20, fill + 17, 3);
			using bad = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(new VideoSampleSink((await bad.getPrimaryVideoTrack())!).getSample(0))
				.rejects.toThrow('ojph error');
			using good = new Input({ source: new BufferSource(readFixture('rgb8.mxf')), formats: [MXF] });
			using sample = (await new VideoSampleSink((await good.getPrimaryVideoTrack())!).getSample(0))!;
			const rgba = new Uint8Array(sample.allocationSize());
			await sample.copyTo(rgba);
			expect([...rgba]).toEqual(expectedRgba);
		});
	});
});
