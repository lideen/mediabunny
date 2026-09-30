import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
	Input, MXF, BufferSource, EncodedPacket, EncodedPacketSink, VideoSampleSink, VideoSample,
} from '../../src/index.js';
import * as core from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import pixels from '../fixtures/mpeg2/pixels.json' with { type: 'json' };
import regression from '../fixtures/mpeg2/wasm-bridct-v1.json' with { type: 'json' };
import packets from '../fixtures/mpeg2/packets.json' with { type: 'json' };
import interlaced from '../fixtures/mpeg2/open/interlaced422.json' with { type: 'json' };
import { anamorphicMpeg2Fixture } from '../mpeg2-fixture.js';

const registration = vi.spyOn(core, 'registerDecoder');
afterAll(() => registration.mockRestore());

const fixture = () => new Uint8Array(readFileSync(new URL('../fixtures/mpeg2/main420.mxf', import.meta.url)));
const inputFor = () => new Input({ source: new BufferSource(fixture()), formats: [MXF] });
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const verify = async (sample: VideoSample, frame: number) => {
	const expected = pixels.frames[frame]!;
	expect([sample.format, sample.codedWidth, sample.codedHeight]).toEqual(['I420', 1280, 720]);
	expect([sample.timestamp, sample.duration]).toEqual([expected.timestamp, expected.duration]);
	const data = new Uint8Array(sample.allocationSize());
	await sample.copyTo(data);
	expect([hash(data.subarray(0, 921600)), hash(data.subarray(921600, 1152000)),
		hash(data.subarray(1152000))]).toEqual(regression.cases.main420.frames[frame]!.planes);
};

const direct = (onSample: (sample: VideoSample) => void, config: Partial<VideoDecoderConfig> = {}) => {
	registerMpeg2Decoder();
	const Decoder = registration.mock.calls[0]![0];
	const decoder = Reflect.construct(Decoder, []) as core.CustomVideoDecoder;
	return Object.assign(decoder, {
		codec: 'mpeg2' as const,
		config: { codec: 'mpeg2', codedWidth: 1280, codedHeight: 720,
			colorSpace: { matrix: 'bt709' as const, fullRange: false }, ...config },
		onSample,
		onError: (error: unknown): undefined => {
			throw error;
		},
	});
};

const encoded = async () => {
	using input = inputFor();
	const result: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink((await input.getPrimaryVideoTrack())!).packets()) {
		result.push(packet);
	}
	return result;
};

describe('given the private MPEG-2 WASM extension', () => {
	describe('when explicitly registering and initializing it', () => {
		it('should enable real decoding through idempotent registration', async () => {
			using input = inputFor();
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.canDecode()).toBe(false);
			registerMpeg2Decoder();
			registerMpeg2Decoder();
			expect(await track.canDecode()).toBe(true);
			using sample = (await new VideoSampleSink(track).getSample(0))!;
			await verify(sample, 0);
		});

		it.each(['before', 'during'] as const)('should reject initialization when closed %s startup', async (when) => {
			const onSample = vi.fn();
			const decoder = direct(onSample);
			try {
				if (when === 'before') {
					await decoder.close();
				}
				const pending = decoder.init();
				const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
				await decoder.close();
				await rejected;
				await expect(decoder.flush()).rejects.toMatchObject({ name: 'AbortError' });
				await expect(decoder.decode(new EncodedPacket(new Uint8Array(), 'key', 0, 0)))
					.rejects.toMatchObject({ name: 'AbortError' });
				expect(onSample).not.toHaveBeenCalled();
			} finally {
				await decoder.close();
			}
		});
	});

	describe('when decoding every picture and the accompanying PCM', () => {
		it('should retain owned pixels through the copying fallback without structuredClone', async () => {
			vi.stubGlobal('structuredClone', undefined);
			try {
				registerMpeg2Decoder();
				using input = inputFor();
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				using sample = (await sink.getSample(0))!;
				using clone = sample.clone();
				sample.close();
				using next = (await sink.getSample(1 / 25))!;
				input.dispose();
				await verify(clone, 0);
				await verify(next, 1);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it('should match regression planes and ffprobe audio, retaining samples after disposal', async () => {
			registerMpeg2Decoder();
			expect(hash(fixture())).toBe(regression.cases.main420.inputSha256);
			const input = inputFor();
			const held: VideoSample[] = [];
			try {
				const track = (await input.getPrimaryVideoTrack())!;
				let count = 0;
				for await (const sample of new VideoSampleSink(track).samples()) {
					held.push(sample);
					await verify(sample, count++);
					expect(sample.colorSpace.matrix).toBe('bt709');
					expect(sample.colorSpace.fullRange).toBe(false);
					expect(sample.colorSpace.primaries).toBeNull();
					expect(sample.colorSpace.transfer).toBeNull();
				}
				expect(count).toBe(18);
				const audio = (await input.getPrimaryAudioTrack())!;
				const expected = packets.packets.filter(p => p.codec_type === 'audio');
				let index = 0;
				for await (const packet of new EncodedPacketSink(audio).packets()) {
					expect(`SHA256:${hash(packet.data)}`).toBe(expected[index]!.data_hash);
					expect([packet.timestamp, packet.duration]).toEqual([index++ / 25, 0.04]);
				}
				expect(index).toBe(18);
				input.dispose();
				for (let i = 0; i < held.length; i++) {
					await verify(held[i]!, i);
				}
			} finally {
				input.dispose();
				held.forEach(sample => sample.close());
			}
		});
	});

	describe('when seeking through partial B intervals and backward key groups', () => {
		it('should preserve exact pictures and timing for individual and batched selections', async () => {
			registerMpeg2Decoder();
			using input = inputFor();
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			for (const frame of [1, 2, 3]) {
				using sample = (await sink.getSample(frame / 25))!;
				await verify(sample, frame);
			}
			for (const frames of [[3, 1, 2, 3], [1, 11, 3, 13]]) {
				let index = 0;
				for await (const sample of sink.samplesAtTimestamps(frames.map(frame => frame / 25))) {
					using owned = sample!;
					await verify(owned, frames[index++]!);
				}
				expect(index).toBe(frames.length);
			}
		});
	});

	describe('when decoding anamorphic Main-profile pictures', () => {
		it('should preserve non-square pixel aspect on real decoded samples and owned clones', async () => {
			registerMpeg2Decoder();
			using input = new Input({ formats: [MXF], source: new BufferSource(anamorphicMpeg2Fixture(fixture())) });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			for (const ordinal of [0, 10]) {
				using sample = (await sink.getSample(ordinal / 25))!;
				await verify(sample, ordinal);
				expect([sample.displayWidth, sample.displayHeight, sample.pixelAspectRatio])
					.toEqual([1280, 960, { num: 3, den: 4 }]);
				using clone = sample.clone();
				sample.close();
				expect([clone.displayWidth, clone.displayHeight, clone.pixelAspectRatio])
					.toEqual([1280, 960, { num: 3, den: 4 }]);
			}
		});
	});

	describe('when a later Main-profile sequence changes color configuration', () => {
		it.each(['primaries', 'transfer', 'matrix'] as const)(
			'should reject changed %s on cold and warm decoded seeks', async (component) => {
				registerMpeg2Decoder();
				const bytes = Buffer.from(fixture());
				const later = packets.packets.filter(packet => packet.codec_type === 'video')[10]!;
				const start = Number(later.pos) + 20;
				const display = bytes.indexOf(Buffer.from('000001b52b020201', 'hex'), start);
				expect(display).toBeGreaterThan(start);
				expect(display).toBeLessThan(start + 512);
				bytes[display + { primaries: 5, transfer: 6, matrix: 7 }[component]] = component === 'matrix' ? 6 : 1;
				for (const warm of [false, true]) {
					using input = new Input({ formats: [MXF], source: new BufferSource(bytes) });
					const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
					if (warm) {
						using first = (await sink.getSample(0))!;
						await verify(first, 0);
						expect([first.colorSpace.primaries, first.colorSpace.transfer, first.colorSpace.matrix])
							.toEqual([null, null, 'bt709']);
					}
					await expect(sink.getSample(10 / 25).then(sample => sample?.close()))
						.rejects.toThrow('MPEG-2 sequence color configuration changed');
				}
			},
		);
	});

	describe('when selecting authored open-GOP and interlaced pictures', () => {
		const openInput = (name = 'open422') => new Input({ formats: [MXF], source: new BufferSource(
			readFileSync(new URL(`../fixtures/mpeg2/open/${name}.mxf`, import.meta.url)),
		) });
		const verifyOpen = async (sample: VideoSample, ordinal: number) => {
			expect([sample.timestamp, sample.duration, sample.format, sample.scan])
				.toEqual([ordinal / 25, 1 / 25, 'I422', 'progressive']);
			const bytes = new Uint8Array(sample.allocationSize());
			await sample.copyTo(bytes);
			expect(hash(bytes)).toBe(regression.cases.open422.frames[ordinal]!.sha256);
		};

		it('should preserve every open-GOP picture, including initial closed-GOP leading Bs', async () => {
			registerMpeg2Decoder();
			using input = openInput();
			let ordinal = 0;
			for await (const sample of new VideoSampleSink((await input.getPrimaryVideoTrack())!).samples()) {
				using owned = sample;
				await verifyOpen(owned, ordinal++);
			}
			expect(ordinal).toBe(36);
		});

		it('should retain requested leading Bs across forward, backward and repeated selections', async () => {
			registerMpeg2Decoder();
			using input = openInput();
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			const targets = [0, 1, 17, 24, 25, 26, 0, 24, 24, 35];
			let index = 0;
			for await (const sample of sink.samplesAtTimestamps(targets.map(x => x / 25))) {
				using owned = sample!;
				await verifyOpen(owned, targets[index++]!);
			}
			expect(index).toBe(targets.length);
		});

		it.each([[-0.1, 0, 3], [24 / 25, 24, 28]])(
			'should preserve a cold range starting at %s with correct header preroll', async (start, first, end) => {
				registerMpeg2Decoder();
				using input = openInput();
				const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
				let ordinal = first;
				for await (const sample of sink.samples(start, end / 25)) {
					using owned = sample;
					await verifyOpen(owned, ordinal++);
				}
				expect(ordinal).toBe(end);
				expect(await sink.getSample(-0.1)).toBeNull();
			},
		);

		it('should retain visible woven I422 pixels and field order on clones after disposal', async () => {
			registerMpeg2Decoder();
			using input = openInput('interlaced422');
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			const held: VideoSample[] = [];
			const targets = [17, 0, 11, 10, 1];
			try {
				for (const ordinal of targets) {
					using sample = (await sink.getSample(ordinal / 25))!;
					held.push(sample.clone());
				}
				input.dispose();
				for (const [index, clone] of held.entries()) {
					const ordinal = targets[index]!;
					expect([clone.format, clone.scan, clone.timestamp, clone.duration,
						clone.codedWidth, clone.codedHeight])
						.toEqual(['I422', 'interlaced-top-first', ordinal / 25, 1 / 25, 64, 48]);
					const pixels = new Uint8Array(clone.allocationSize());
					await clone.copyTo(pixels);
					expect(hash(pixels)).toBe(interlaced.faani[ordinal]);
				}
			} finally {
				held.forEach(sample => sample.close());
			}
		});
	});

	describe('when reusing registered packet decoders', () => {
		it('should preserve timing across selection flushes and more than 64 packets', async () => {
			const source = await encoded();
			const outputs: VideoSample[] = [];
			const decoder = direct(sample => outputs.push(sample));
			await decoder.init();
			try {
				await decoder.flush();
				await decoder.flush();
				for (const [index, timestamp, duration] of [[0, -2.5, 0.125], [1, 7, 0.375], [2, -2.5, 0.25]]) {
					const packet = source[index!]!;
					await decoder.decode(new EncodedPacket(packet.data, packet.type, timestamp!, duration!));
				}
				await decoder.flush();
				expect(outputs.map(s => [s.timestamp, s.duration])).toEqual([[-2.5, 0.125], [-2.5, 0.25], [7, 0.375]]);
				outputs.splice(0).forEach(s => s.close());
				// Five closed-GOP streams, no flush/reset between streams: 90 packets in one native lifetime.
				for (let cycle = 0; cycle < 5; cycle++) {
					for (const packet of source) {
						await decoder.decode(packet);
					}
				}
				await decoder.flush();
				expect(outputs.length).toBe(90);
				await decoder.close();
				for (let i = 0; i < outputs.length; i++) {
					await verify(outputs[i]!, i % 18);
				}
			} finally {
				await decoder.close();
				outputs.forEach(s => s.close());
			}
		});

		it('should keep malformed-picture errors sticky without damaging another decoder', async () => {
			const source = await encoded();
			const outputs: VideoSample[] = [];
			const broken = direct(sample => outputs.push(sample));
			const healthy = direct(sample => outputs.push(sample));
			await Promise.all([broken.init(), healthy.init()]);
			try {
				await broken.decode(source[0]!);
				const truncated = new EncodedPacket(source[1]!.data.subarray(0, 30), 'delta', 0.12, 0.04);
				await expect(broken.decode(truncated)).rejects.toThrow();
				await expect(broken.decode(source[1]!)).rejects.toThrow();
				await expect(broken.flush()).rejects.toThrow();
				await healthy.decode(source[0]!);
				await healthy.flush();
				expect(outputs.length).toBe(1);
				await verify(outputs[0]!, 0);
			} finally {
				await broken.close();
				await healthy.close();
				outputs.forEach(s => s.close());
			}
		});

		it.each(['close', 'throw'] as const)('should stop outputs when a callback invokes %s', async (action) => {
			const source = await encoded();
			const outputs: VideoSample[] = [];
			const failure = new Error('Consumer callback failed');
			const decoder = direct((sample) => {
				outputs.push(sample);
				if (sample.timestamp === 8 / 25) {
					if (action === 'throw') {
						throw failure;
					}
					void decoder.close();
				}
			});
			await decoder.init();
			try {
				for (const packet of source.slice(0, 9)) {
					await decoder.decode(packet);
				}
				if (action === 'throw') {
					await expect(decoder.decode(source[9]!)).rejects.toBe(failure);
				} else {
					await decoder.decode(source[9]!);
				}
				expect(outputs.map(s => s.timestamp)).toEqual(Array.from({ length: 9 }, (_, i) => i / 25));
				if (action === 'throw') {
					await expect(decoder.flush()).rejects.toBe(failure);
					expect(() => outputs.pop()!.clone()).toThrow('closed');
				} else {
					await expect(decoder.flush()).rejects.toMatchObject({ name: 'AbortError' });
				}
				for (let i = 0; i < outputs.length; i++) {
					await verify(outputs[i]!, i);
				}
			} finally {
				await decoder.close();
				outputs.forEach(s => s.close());
			}
		});

		it('should reject unsupported configuration and mismatched output dimensions', async () => {
			const onSample = vi.fn();
			for (const config of [{ codedWidth: 0 }, { codedHeight: 4096 }, { description: new Uint8Array() }]) {
				const decoder = direct(onSample, config);
				try {
					await expect(decoder.init()).rejects.toThrow(/configuration/);
				} finally {
					await decoder.close();
				}
			}
			const decoder = direct(onSample, { codedWidth: 640 });
			await decoder.init();
			try {
				await decoder.decode((await encoded())[0]!);
				await expect(decoder.flush()).rejects.toThrow(/dimensions/);
				expect(onSample).not.toHaveBeenCalled();
			} finally {
				await decoder.close();
			}
		});
	});
});
