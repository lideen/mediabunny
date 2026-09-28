import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
	Input, MXF, BufferSource, EncodedPacket, EncodedPacketSink, VideoSampleSink, VideoSample,
} from '../../src/index.js';
import * as core from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import pixels from '../fixtures/mpeg2/pixels.json' with { type: 'json' };
import regression from '../fixtures/mpeg2/wasm-idct-v1.json' with { type: 'json' };
import packets from '../fixtures/mpeg2/packets.json' with { type: 'json' };

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
		onError: (error: unknown): undefined => { throw error; },
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
				if (when === 'before') await decoder.close();
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
		it('should preserve owned pixels through the copying path without structuredClone', async () => {
			registerMpeg2Decoder();
			using input = inputFor();
			vi.stubGlobal('structuredClone', undefined);
			try {
				const track = (await input.getPrimaryVideoTrack())!;
				using sample = (await new VideoSampleSink(track).getSample(0))!;
				input.dispose();
				await verify(sample, 0);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it('should match qualified WASM planes and ffprobe audio, retaining samples after disposal', async () => {
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
					if (action === 'throw') throw failure;
					void decoder.close();
				}
			});
			await decoder.init();
			try {
				for (const packet of source.slice(0, 9)) {
					await decoder.decode(packet);
				}
				if (action === 'throw') await expect(decoder.decode(source[9]!)).rejects.toBe(failure);
				else await decoder.decode(source[9]!);
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
