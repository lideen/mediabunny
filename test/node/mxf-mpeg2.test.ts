import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
	Input, MXF, ALL_FORMATS, BufferSource, UrlSource, EncodedPacketSink, VideoSampleSink,
	canDecodeVideo, canEncodeVideo, Mp4OutputFormat, CmafOutputFormat, MovOutputFormat, MkvOutputFormat,
	Output, BufferTarget, EncodedVideoPacketSource, EncodedPacket,
	CustomVideoDecoder, registerDecoder, type VideoCodec,
} from '../../src/index.js';
import manifest from '../fixtures/mpeg2/packets.json' with { type: 'json' };

const fixture = () => new Uint8Array(readFileSync(new URL('../fixtures/mpeg2/main420.mxf', import.meta.url)));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const videoPackets = manifest.packets.filter(p => p.codec_type === 'video');
const audioPackets = manifest.packets.filter(p => p.codec_type === 'audio');

const boundedSource = (data: Uint8Array, read: (start: number, end: number) => void | Promise<void>) => {
	return new UrlSource('https://fixture.invalid/main420.mxf', {
		rangePolicy: { minimumRequestSize: 1 },
		getRetryDelay: () => null,
		fetchFn: async (_, init) => {
			const range = new Headers(init?.headers).get('Range')!;
			const match = /^bytes=(\d+)-(\d+)$/.exec(range);
			if (!match) {
				throw new Error(`Nonfinite fixture read: ${range}`);
			}
			const start = Number(match[1]);
			const end = Math.min(Number(match[2]) + 1, data.length);
			await read(start, end);
			return new Response(data.slice(start, end), { status: 206,
				headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` } });
		},
	});
};

const replace = (data: Uint8Array, before: string, after: string) => {
	const offset = Buffer.from(data).indexOf(Buffer.from(before, 'hex'));
	if (offset < 0) {
		throw new Error(`Missing fixture bytes ${before}`);
	}
	data.set(Buffer.from(after, 'hex'), offset);
};

const indexEntry = (data: Uint8Array, decode: number) => {
	const array = Buffer.from(data).indexOf(Buffer.from('3f0a0116000000120000000f', 'hex'), 231424);
	if (array < 0) {
		throw new Error('Missing fixture index entry array');
	}
	return data.subarray(array + 12 + decode * 15, array + 12 + (decode + 1) * 15);
};

describe('given progressive Main Profile / High Level MPEG-2 in an unmodified OP1a MXF', () => {
	describe('when classifying externally supplied packets', () => {
		it('should prove restart headers rather than treating every I picture as a key', async () => {
			using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			const first = (await new EncodedPacketSink(track).getFirstPacket())!;
			const openGop = first.data.slice();
			openGop[41] = 0;
			const embeddedPicture = Uint8Array.of(0, 0, 1, 0xb2, 0, 0, 1, 0, 0, 8);
			for (const data of [first.data.subarray(42), first.data.subarray(0, 49),
				openGop, embeddedPicture, new Uint8Array()]) {
				expect(await track.determinePacketType(new EncodedPacket(data, 'key', 0, 0.04))).toBeNull();
			}
			expect(await track.determinePacketType(first)).toBe('key');
			const sink = new EncodedPacketSink(track);
			for (const time of [0.12, 0.04]) {
				expect(await track.determinePacketType((await sink.getPacket(time))!)).toBe('delta');
			}
		});
	});

	describe('when reading metadata and complete video/audio packets', () => {
		it('should preserve every ffprobe payload, presentation timestamp and decode ordinal', async () => {
			using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getCodec()).toBe('mpeg2');
			expect(await track.hasOnlyKeyPackets()).toBe(false);
			expect(await track.getDecoderConfig()).toEqual({ codec: 'mpeg2', codedWidth: 1280, codedHeight: 720,
				colorSpace: { primaries: undefined, transfer: undefined, matrix: 'bt709', fullRange: false } });
			expect(await input.computeDuration()).toBe(0.72);
			const audio = (await input.getPrimaryAudioTrack())!;
			expect(await audio.getDecoderConfig()).toMatchObject({ codec: 'pcm-s16', sampleRate: 48000,
				numberOfChannels: 2 });
			for (const [owner, oracle] of [[track, videoPackets], [audio, audioPackets]] as const) {
				const sink = new EncodedPacketSink(owner);
				let packet = await sink.getFirstPacket();
				for (let i = 0; i < oracle.length; i++) {
					const expected = oracle[i]!;
					expect(packet).not.toBeNull();
					expect([packet!.sequenceNumber, packet!.timestamp, packet!.duration,
						packet!.byteLength, packet!.type])
						.toEqual([i, Number(expected.pts_time), 0.04, Number(expected.size),
							expected.flags.startsWith('K') ? 'key' : 'delta']);
					expect(`SHA256:${hash(packet!.data)}`).toBe(expected.data_hash);
					if (owner === track) {
						expect(await track.determinePacketType(packet!)).toBe(packet!.type);
					}
					const meta = (await sink.getPacket(Number(expected.pts_time), { metadataOnly: true }))!;
					expect([meta.sequenceNumber, meta.timestamp, meta.type, meta.byteLength, meta.data.length])
						.toEqual([i, packet!.timestamp, packet!.type, packet!.byteLength, 0]);
					packet = await sink.getNextPacket(packet!);
				}
				expect(packet).toBeNull();
			}
		});
	});

	describe('when seeking into reordered pictures across two closed GOPs', () => {
		it('should return presentation predecessors and restart keys while traversing in decode order', async () => {
			using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			for (const [pts, decode] of [[1, 2], [2, 3], [3, 1], [10, 10], [11, 12], [13, 11]]) {
				const packet = (await sink.getPacket(pts! / 25))!;
				expect([packet.sequenceNumber, packet.timestamp]).toEqual([decode, pts! / 25]);
				expect((await sink.getNextPacket(packet))!.sequenceNumber).toBe(decode! + 1);
				const key = (await sink.getKeyPacket(pts! / 25, { verifyKeyPackets: true }))!;
				expect([key.sequenceNumber, key.timestamp]).toEqual(pts! < 10 ? [0, 0] : [10, 0.4]);
			}
			const first = (await sink.getFirstPacket())!;
			const second = (await sink.getNextKeyPacket(first, { metadataOnly: true }))!;
			expect([second.sequenceNumber, second.timestamp, second.type]).toEqual([10, 0.4, 'key']);
			expect(await sink.getNextKeyPacket(second)).toBeNull();
			expect((await sink.getPacket(0.4 - 1e-10))!.sequenceNumber).toBe(7);
			expect((await sink.getKeyPacket(Infinity))!.sequenceNumber).toBe(10);
		});
	});

	describe('when requesting metadata with a large prefetch hint', () => {
		it('should inspect bounded headers rather than fetch complete essence', async () => {
			const data = fixture();
			const reads: [number, number][] = [];
			using input = new Input({ source: boundedSource(data, (start, end) => {
				reads.push([start, end]);
			}), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const meta = (await sink.getKeyPacket(0.52, { metadataOnly: true, prefetchBytes: 65536 }))!;
			expect([meta.sequenceNumber, meta.byteLength, meta.data.length]).toEqual([10, 15257, 0]);
			for (const packet of videoPackets) {
				const payload = Number(packet.pos) + 20;
				expect(reads.filter(([start, end]) => end > payload + 512 && start < payload + Number(packet.size)))
					.toEqual([]);
			}
			expect(`SHA256:${hash((await sink.getKeyPacket(0.52))!.data)}`).toBe(videoPackets[10]!.data_hash);
		});
	});

	describe('when a packet request is canceled during source I/O', () => {
		it.each(['index', 'header', 'payload'] as const)(
			'should stop %s navigation and leave the input usable', async (phase) => {
				const data = fixture();
				const payload = Number(videoPackets[10]!.pos) + 20;
				let entered!: () => void;
				let release!: () => void;
				const blocked = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				let pause = true;
				let requests = 0;
				using input = new Input({ source: boundedSource(data, async (start, end) => {
					requests++;
					const selected = phase === 'index'
						? start >= 231424
						: phase === 'header'
							? start >= payload && end <= payload + 512
							: start >= payload + 512 && start < payload + Number(videoPackets[10]!.size);
					if (pause && selected) {
						pause = false;
						entered();
						await gate;
					}
				}), formats: [MXF] });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				const controller = new AbortController();
				const pending = sink.getKeyPacket(0.52, {
					metadataOnly: phase !== 'payload', signal: controller.signal,
				});
				const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
				await blocked;
				const before = requests;
				controller.abort();
				release();
				await rejected;
				expect(requests).toBe(before);
				expect(`SHA256:${hash((await sink.getKeyPacket(0.52))!.data)}`).toBe(videoPackets[10]!.data_hash);
			},
		);
	});

	describe('when checking custom decoder capability', () => {
		it('should use registration rather than native WebCodecs without enabling output or implicit MXF', async () => {
			using input = new Input({ source: new BufferSource(fixture()), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			class ConfigOnlyDecoder extends CustomVideoDecoder {
				static enabled = false;
				static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
					return this.enabled && codec === 'mpeg2'
						&& config.codedWidth === 1280 && config.codedHeight === 720;
				}

				init() { throw new Error('Custom MPEG-2 initialization reached'); }
				decode() { throw new Error('Capability probe does not decode pixels'); }
				flush() {}
				close() {}
			}
			const config = (await track.getDecoderConfig())!;
			const nativeProbe = vi.fn(() => {
				throw new Error('Native MPEG-2 probe');
			});
			vi.stubGlobal('VideoDecoder', { isConfigSupported: nativeProbe });
			vi.stubGlobal('VideoEncoder', { isConfigSupported: nativeProbe });
			try {
				expect(await track.canDecode()).toBe(false);
				expect(await canDecodeVideo('mpeg2', config)).toBe(false);
				expect(await canEncodeVideo('mpeg2')).toBe(false);
				await expect(new VideoSampleSink(track).getSample(0))
					.rejects.toThrow(/MPEG-2 requires a registered custom decoder/);
				registerDecoder(ConfigOnlyDecoder);
				ConfigOnlyDecoder.enabled = true;
				expect(await track.canDecode()).toBe(true);
				expect(await canDecodeVideo('mpeg2', config)).toBe(true);
				await expect(new VideoSampleSink(track).getSample(0))
					.rejects.toThrow('Custom MPEG-2 initialization reached');
				ConfigOnlyDecoder.enabled = false;
				expect(await canDecodeVideo('mpeg2', config)).toBe(false);
				expect(nativeProbe).not.toHaveBeenCalled();
			} finally {
				ConfigOnlyDecoder.enabled = false;
				vi.unstubAllGlobals();
			}
			expect(ALL_FORMATS).not.toContain(MXF);
			const formats = [new Mp4OutputFormat(), new CmafOutputFormat(),
				new MovOutputFormat(), new MkvOutputFormat()];
			for (const format of formats) {
				const output = new Output({ format, target: new BufferTarget() });
				expect(() => output.addVideoTrack(new EncodedVideoPacketSource('mpeg2'))).toThrow(/codec/i);
			}
		});
	});

	describe('when descriptor or index claims contradict the supported subset', () => {
		it('should resolve MPEG descriptor properties through remapped Primer tags', async () => {
			const data = fixture();
			replace(data, '8004060e2b34010101050401060201060000', 'a004060e2b34010101050401060201060000');
			replace(data, '8004000101', 'a004000101');
			replace(data, '8007060e2b340101010504010602010a0000', 'a007060e2b340101010504010602010a0000');
			replace(data, '8007000144', 'a007000144');
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getDecoderConfig()).toMatchObject({
				codec: 'mpeg2', codedWidth: 1280, codedHeight: 720,
			});
		});

		it.each([
			['random access point', 0, 2, 0xc4],
			['picture flags disagree', 1, 2, 0x33],
			['unique inverse', 1, 0, 0],
			['intervening key', 11, 1, 245],
		] as const)('should reject an index with invalid %s', async (error, decode, field, value) => {
			const data = fixture();
			indexEntry(data, decode)[field] = value;
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(decode === 11 ? 0.52 : 0.12, { metadataOnly: true }))
				.rejects.toThrow(error);
		});

		it('should reject a cold I-picture key that lacks its own sequence headers', async () => {
			const data = fixture();
			const start = Number(videoPackets[10]!.pos) + 20;
			data.copyWithin(start, start + 42, start + Number(videoPackets[10]!.size));
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(0.52, { metadataOnly: true })).rejects.toThrow(/requires in-band sequence/);
		});

		it.each([
			['picture coding', '060e2b34040101030401020201030300', '060e2b34040101030401020201020300'],
			['frame wrapping', '060e2b34040101020d01030102046001', '060e2b34040101020d01030102046101'],
			['interlaced', '320c000100', '320c000101'],
			['8-bit 4:2:0', '3308000400000002', '3308000400000001'],
			['temporal index', '3f06000400000002', '3f06000400000000'],
		] as const)('should reject %s at the metadata boundary', async (error, before, after) => {
			const data = fixture();
			// Container UL also occurs in partition metadata. Replace all copies of this label.
			if (error === 'frame wrapping') {
				let offset = 0;
				while ((offset = Buffer.from(data).indexOf(Buffer.from(before, 'hex'), offset)) >= 0) {
					data.set(Buffer.from(after, 'hex'), offset);
					offset += 16;
				}
			} else {
				replace(data, before, after);
			}
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(input.getPrimaryVideoTrack()).rejects.toThrow(error);
		});

		it.each([
			['sequence/GOP', 0, 0xb2],
			['I/P-only GOP', 41, 0],
			['cropping', 5, 1],
			['progressive', 17, 0x40],
			['picture type', 47, 0x27],
		] as const)('should reject a later key with invalid %s', async (error, offset, value) => {
			const data = fixture();
			const start = Number(videoPackets[10]!.pos) + 20;
			data[start + (offset === 0 ? 3 : offset)] = value;
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(0.52, { metadataOnly: true })).rejects.toThrow(
				error === 'sequence/GOP' ? /unsupported MPEG-2 header/ : new RegExp(error),
			);
		});
	});
});
