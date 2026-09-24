import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
	Input, MXF, BufferSource, CustomSource, EncodedPacketSink, VideoSampleSink, canDecodeVideo,
	Mp4OutputFormat, CmafOutputFormat, MovOutputFormat, MkvOutputFormat, Output, BufferTarget, EncodedVideoPacketSource,
} from '../../src/index.js';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import makeHTCodec from '../../packages/htj2k/vendor/HT_internal.js';
import { makeMxf } from './mxf-fixture.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

const fixture = (bits = 16) => ({
	data: new Uint8Array(readFileSync(new URL(`../fixtures/htj2k/rgb${bits}.j2c`, import.meta.url))), bits,
});
const expectedRow = [
	0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
	0, 0, 255, 255, 17, 83, 201, 255, 128, 64, 32, 255, 254, 1, 127, 255,
];

describe('given complete-frame HTJ2K MXF input', () => {
	describe('when the optional decoder is registered', () => {
		it('should change capability from unavailable to available without enabling muxing', async () => {
			using input = new Input({ source: new BufferSource(makeMxf({ htj2k: fixture(), videoOnly: true }).data),
				formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			const config = (await track.getDecoderConfig())!;
			expect(config).toEqual({ codec: 'htj2k', codedWidth: 8, codedHeight: 4,
				description: Uint8Array.of(16),
				colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true } });
			const nativeProbe = vi.fn(() => {
				throw new Error('Native WebCodecs must not receive HTJ2K');
			});
			vi.stubGlobal('VideoDecoder', { isConfigSupported: nativeProbe });
			try {
				expect(await track.canDecode()).toBe(false);
				expect(await canDecodeVideo('htj2k', config)).toBe(false);
				expect(nativeProbe).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
			}
			registerHtj2kDecoder();
			registerHtj2kDecoder();
			expect(await track.canDecode()).toBe(true);
			expect(await canDecodeVideo('htj2k', config)).toBe(true);
			expect(await canDecodeVideo('htj2k', { ...config, description: Uint8Array.of(12) })).toBe(false);
			const formats = [new Mp4OutputFormat(), new CmafOutputFormat(),
				new MovOutputFormat(), new MkvOutputFormat()];
			for (const format of formats) {
				expect(format.getSupportedCodecs()).not.toContain('htj2k');
				const output = new Output({ format, target: new BufferTarget() });
				expect(() => output.addVideoTrack(new EncodedVideoPacketSource('htj2k'))).toThrow(/codec/i);
			}
			const compilation = vi.spyOn(WebAssembly, 'compile').mockRejectedValueOnce(new Error('WASM unavailable'));
			try {
				await expect(new VideoSampleSink(track).getSample(0)).rejects.toThrow('WASM unavailable');
			} finally {
				compilation.mockRestore();
			}
			using recovered = (await new VideoSampleSink(track).getSample(0))!;
			expect(recovered.codedWidth).toBe(8);
		});
	});

	describe('when capability descriptions use buffers or offset views', () => {
		it.each([
			['ArrayBuffer', 16, 12, 8], ['ArrayBuffer', 12, 16, 9],
			['DataView', 16, 12, 10], ['DataView', 12, 16, 11],
		] as const)('should distinguish %s depths %i then %i without caching their serialized shape',
			async (format, firstDepth, secondDepth, codedWidth) => {
				registerHtj2kDecoder();
				for (const bits of [firstDepth, secondDepth, firstDepth]) {
					const description = format === 'ArrayBuffer'
						? Uint8Array.of(bits).buffer
						: new DataView(Uint8Array.of(bits === 16 ? 12 : 16, bits, 0).buffer, 1, 1);
					expect(await canDecodeVideo('htj2k', {
						codec: 'htj2k', codedWidth, codedHeight: 4, description,
						colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true },
					})).toBe(bits === 16);
				}
			});
	});

	describe('when descriptor metadata is unsupported', () => {
		it.each([
			['RGB layout', '52104710421000000000000000000000', '59104710421000000000000000000000'],
			['primaries', '060e2b34040101060401010103030000', '060e2b34040101060401010103040000'],
			['transfer', '060e2b34040101010401010101020000', '060e2b34040101010401010101010000'],
			['picture coding', '060e2b340401010d0401020203010801', '060e2b340401010d0401020203010100'],
		] as const)('should reject %s rather than guess ProRes or a different RGB interpretation',
			async (_name, before, after) => {
				const data = makeMxf({ htj2k: fixture(), videoOnly: true }).data;
				const offset = Buffer.from(data).indexOf(Buffer.from(before, 'hex'));
				expect(offset).toBeGreaterThan(0);
				data.set(Buffer.from(after, 'hex'), offset);
				using input = new Input({ source: new BufferSource(data), formats: [MXF] });
				await expect(input.getPrimaryVideoTrack()).rejects.toThrow(/HTJ2K/);
			});
	});

	describe('when seeking with an index', () => {
		it('should preserve complete key packets and timing without reading metadata-only payloads', async () => {
			const htj2k = fixture();
			const source = makeIndexedMxf({ htj2k, editRate: [24, 1] });
			using input = new Input({ source: new CustomSource({ getSize: () => source.size, read: source.read }),
				formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new EncodedPacketSink(track);
			expect(await track.getCodec()).toBe('htj2k');
			expect(await track.hasOnlyKeyPackets()).toBe(true);
			const meta = (await sink.getPacket(375, { metadataOnly: true }))!;
			expect([meta.sequenceNumber, meta.timestamp, meta.duration, meta.type, meta.byteLength])
				.toEqual([9000, 375, 1 / 24, 'key', htj2k.data.length]);
			expect(meta.data.byteLength).toBe(0);
			const payloadOffset = source.offsets[2]! + 108 + 1000 * source.stride + 32 + 20;
			expect(source.reads.every(([start, end]) =>
				end <= payloadOffset + 5 || start >= payloadOffset + htj2k.data.length))
				.toBe(true);
			expect((await sink.getKeyPacket(375))!.data).toEqual(htj2k.data);
			expect((await sink.getNextPacket(meta))!.timestamp).toBe(9001 / 24);
		});
	});

	describe('when decoding RGB8 and RGB16', () => {
		it('should release a decoder after a native truncated-packet error', async () => {
			registerHtj2kDecoder();
			const htj2k = fixture(8);
			htj2k.data = htj2k.data.slice(0, 129);
			new DataView(htj2k.data.buffer).setUint32(115, 18);
			htj2k.data.set([0xff, 0xd9], 127);
			using input = new Input({ source: new BufferSource(makeMxf({ htj2k, videoOnly: true }).data),
				formats: [MXF] });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getSample(0).then((sample) => {
				sample?.close();
				return 'unexpected concealed frame';
			})).rejects.toThrow();
			using good = new Input({ source: new BufferSource(makeMxf({ htj2k: fixture(8), videoOnly: true }).data),
				formats: [MXF] });
			using sample = (await new VideoSampleSink((await good.getPrimaryVideoTrack())!).getSample(0))!;
			const rgba = new Uint8Array(sample.allocationSize());
			await sample.copyTo(rgba);
			expect([...rgba.slice(0, 32)]).toEqual(expectedRow);
		});

		it.each([8, 16])('should retain owned RGBA8 samples, BT.709 metadata, and timing from RGB%i', async (bits) => {
			registerHtj2kDecoder();
			using input = new Input({ source: new BufferSource(makeMxf({ htj2k: fixture(bits), videoOnly: true,
				editRate: [24, 1] }).data), formats: [MXF] });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			using first = (await sink.getSample(0))!;
			using later = (await sink.getSample(2 / 24))!;
			const bytes = new Uint8Array(first.allocationSize());
			await first.copyTo(bytes);
			expect([...bytes]).toEqual(Array.from({ length: 4 }, () => expectedRow).flat());
			expect([first.timestamp, first.duration, later.timestamp]).toEqual([0, 1 / 24, 2 / 24]);
			expect(first.colorSpace).toMatchObject({
				primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true,
			});
		});

		it.each([
			['signed components', 42, 143], ['subsampled components', 43, 2], ['wrong geometry', 11, 9],
			['unsupported depth', 42, 11], ['truncated tile', 218, 0],
		] as const)('should reject %s and leave the decoder usable for a later input', async (_name, offset, value) => {
			registerHtj2kDecoder();
			const htj2k = fixture(8);
			htj2k.data[offset] = value;
			using bad = new Input({ source: new BufferSource(makeMxf({ htj2k, videoOnly: true }).data),
				formats: [MXF] });
			const badSink = new VideoSampleSink((await bad.getPrimaryVideoTrack())!);
			await expect(badSink.getSample(0)).rejects.toThrow(/HTJ2K/);
			using good = new Input({ source: new BufferSource(makeMxf({ htj2k: fixture(8), videoOnly: true }).data),
				formats: [MXF] });
			using sample = (await new VideoSampleSink((await good.getPrimaryVideoTrack())!).getSample(0))!;
			const bytes = new Uint8Array(sample.allocationSize());
			await sample.copyTo(bytes);
			expect([...bytes.slice(0, 32)]).toEqual(expectedRow);
		});
	});
});

const evidence = process.env['HTJ2K_EVIDENCE'];
describe.skipIf(!evidence)('given the retained real-source ranges and independent FFmpeg RGB16 oracle', () => {
	it('should demux the original graph and compare every full-precision component and quantized sample', async () => {
		const header = readFileSync(`${evidence}/header.bin`);
		const tail = readFileSync(`${evidence}/tail.bin`);
		const frame = readFileSync(`${evidence}/firstframe.jph`);
		const reference = readFileSync(`${evidence}/ffmpeg-rgb48le.raw`);
		expect(createHash('sha256').update(frame).digest('hex'))
			.toBe('d85998d2140700455f00d2c78da443f488b2cb1d277dc8da1e97f20b3183840f');
		expect(createHash('sha256').update(reference).digest('hex'))
			.toBe('1a57dbe7cafe17e294e679e66d2aff6d1fe4852ade6597ca9bab37fa0755d6ce');
		const size = 17_739_213_263;
		const ranges = [{ offset: 0, data: header }, { offset: size - tail.length, data: tail },
			{ offset: 16545, data: frame }];
		let readBytes = 0;
		using input = new Input({ source: new CustomSource({ getSize: () => size, read: (start, end) => {
			readBytes += end - start;
			const range = ranges.find(x => start >= x.offset && end <= x.offset + x.data.length);
			if (!range) {
				throw new Error(`Read outside retained evidence: ${start}..${end}`);
			}
			return range.data.subarray(start - range.offset, end - range.offset);
		} }), formats: [MXF] });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getCodec()).toBe('htj2k');
		const config = (await track.getDecoderConfig())!;
		expect([config.codedWidth, config.codedHeight]).toEqual([3840, 2160]);
		const packet = (await new EncodedPacketSink(track).getFirstPacket())!;
		expect(createHash('sha256').update(packet.data).digest('hex'))
			.toBe('d85998d2140700455f00d2c78da443f488b2cb1d277dc8da1e97f20b3183840f');
		expect([packet.timestamp, packet.duration, packet.type]).toEqual([0, 1 / 24, 'key']);
		expect(readBytes).toBeLessThan(frame.length + 1_000_000);
		const wasm = await WebAssembly.compile(readFileSync(new URL('../../packages/htj2k/vendor/HT_internal.wasm',
			import.meta.url)));
		const module = await makeHTCodec({ instantiateWasm(imports, receive) {
			const instance = new WebAssembly.Instance(wasm, imports);
			receive(instance);
			return instance.exports;
		} });
		const decoder = new module.HTDecoder(frame.length);
		const full = Buffer.alloc(reference.length);
		try {
			decoder.getCodestreamBuffer().set(frame);
			expect(decoder.readHeader()).not.toBeInstanceOf(Error);
			expect(decoder.startDecoding(0, false)).not.toBeInstanceOf(Error);
			for (let y = 0; y < 2160; y++) {
				for (let c = 0; c < 3; c++) {
					const row = decoder.decodeLineAsUnsignedSamples();
					if (row instanceof Error) {
						throw row;
					}
					for (let x = 0; x < 3840; x++) {
						full.writeUInt16LE(row[x]!, ((y * 3840 + x) * 3 + c) * 2);
					}
				}
			}
		} finally {
			decoder.delete();
		}
		expect(createHash('sha256').update(full).digest('hex'))
			.toBe(createHash('sha256').update(reference).digest('hex'));
		registerHtj2kDecoder();
		using sample = (await new VideoSampleSink(track).getSample(0))!;
		const rgba = new Uint8Array(sample.allocationSize());
		await sample.copyTo(rgba);
		const expected = new Uint8Array(rgba.length);
		for (let i = 0; i < 3840 * 2160; i++) {
			expected[i * 4] = reference[i * 6 + 1]!;
			expected[i * 4 + 1] = reference[i * 6 + 3]!;
			expected[i * 4 + 2] = reference[i * 6 + 5]!;
			expected[i * 4 + 3] = 255;
		}
		expect(createHash('sha256').update(rgba).digest('hex'))
			.toBe(createHash('sha256').update(expected).digest('hex'));
	}, 60_000);
});
