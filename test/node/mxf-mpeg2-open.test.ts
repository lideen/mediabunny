import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
	Input, BufferSource, CustomSource, MXF, EncodedPacketSink, VideoSampleSink, type VideoSample,
	CustomVideoDecoder, registerDecoder, type VideoCodec,
} from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import manifest from '../fixtures/mpeg2/open/open422.json' with { type: 'json' };
import interlaced from '../fixtures/mpeg2/open/interlaced422.json' with { type: 'json' };
import { makeMxf } from './mxf-fixture.js';

const source = () => new BufferSource(readFileSync(new URL('../fixtures/mpeg2/open/open422.mxf', import.meta.url)));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
class NoPrerollDecoder extends CustomVideoDecoder {
	static enabled = false;
	static override supports(codec: VideoCodec) {
		return this.enabled && codec === 'mpeg2';
	}

	init() {}
	decode() {}
	flush() {}
	close() {}
}
registerDecoder(NoPrerollDecoder);
const verify = async (sample: VideoSample, ordinal: number) => {
	expect([sample.timestamp, sample.duration, sample.format, sample.scan])
		.toEqual([ordinal / 25, 1 / 25, 'I422', 'progressive']);
	const bytes = new Uint8Array(sample.allocationSize());
	await sample.copyTo(bytes);
	expect(hash(bytes)).toBe(manifest.faani[ordinal]);
};

describe('given authored 4:2:2 open GOPs with a leading-B-only matrix update', () => {
	it('should expose visible woven I422 frames and retain native field order on an owned clone', async () => {
		registerMpeg2Decoder();
		using input = new Input({ formats: [MXF], source: new BufferSource(readFileSync(
			new URL('../fixtures/mpeg2/open/interlaced422.mxf', import.meta.url),
		)) });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getDecoderConfig()).toMatchObject({ codedWidth: 64, codedHeight: 48 });
		const sink = new VideoSampleSink(track);
		for (const ordinal of [17, 0, 11, 10, 1]) {
			const sample = (await sink.getSample(ordinal / 25))!;
			using clone = sample.clone();
			sample.close();
			expect([clone.format, clone.scan, clone.timestamp, clone.duration, clone.codedWidth, clone.codedHeight])
				.toEqual(['I422', 'interlaced-top-first', ordinal / 25, 1 / 25, 64, 48]);
			const pixels = new Uint8Array(clone.allocationSize());
			await clone.copyTo(pixels);
			expect(hash(pixels)).toBe(interlaced.faani[ordinal]);
		}
	});

	it('should omit only non-essence static DM tracks without hiding audio tracks', async () => {
		using input = new Input({ source: new BufferSource(makeMxf({ staticDmTrackNumber: 0 }).data), formats: [MXF] });
		expect((await input.getVideoTracks()).length).toBe(1);
		expect((await input.getAudioTracks()).length).toBe(2);
		using invalid = new Input({
			source: new BufferSource(makeMxf({ staticDmTrackNumber: 1 }).data), formats: [MXF],
		});
		await expect(invalid.getTracks()).rejects.toThrow('unsupported descriptive metadata track');
	});

	it('should reject a decoder without header-preroll capability rather than silently omit state', async () => {
		NoPrerollDecoder.enabled = true;
		try {
			using input = new Input({ source: source(), formats: [MXF] });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getSample(17 / 25)).rejects.toThrow('does not support header-only preroll');
		} finally {
			NoPrerollDecoder.enabled = false;
		}
	});

	it('should preserve every source packet in decode order without preroll omissions', async () => {
		using input = new Input({ source: source(), formats: [MXF] });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		let i = 0;
		for await (const packet of sink.packets()) {
			const expected = manifest.packets[i++]!;
			expect([packet.timestamp, packet.duration, `SHA256:${hash(packet.data)}`])
				.toEqual([expected.pts / 25, 1 / 25, expected.data_hash]);
		}
		expect(i).toBe(36);
		expect(await sink.getKeyPacket(0)).toBeNull();
	});

	it.each([
		['temporal reference', 'temporal reference disagrees'],
		['field picture', 'requires frame pictures'],
		['repeated field', 'repeated fields are unsupported'],
	] as const)('should reject an invalid %s before emitting a selected leading picture', async (kind, error) => {
		registerMpeg2Decoder();
		const data = readFileSync(new URL('../fixtures/mpeg2/open/open422.mxf', import.meta.url));
		const start = Number(manifest.packets[1]!.pos) + 20;
		const picture = data.indexOf(Buffer.from('00000100', 'hex'), start);
		const extension = data.indexOf(Buffer.from('000001b5', 'hex'), picture + 4) + 4;
		if (kind === 'temporal reference') data[picture + 5] = (data[picture + 5]! & 0x3f) | 0xc0;
		else if (kind === 'field picture') data[extension + 2] = (data[extension + 2]! & ~3) | 1;
		else data[extension + 3] = data[extension + 3]! | 2;
		using input = new Input({ source: new BufferSource(data), formats: [MXF] });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		await expect(sink.getSample(0)).rejects.toThrow(error);
	});

	it('should reject a dependency that jumps over the preceding GOP instead of walking back arbitrarily', async () => {
		registerMpeg2Decoder();
		const data = readFileSync(new URL('../fixtures/mpeg2/open/open422.mxf', import.meta.url));
		let field = data.indexOf(Buffer.from('060e2b34025301010d01020101100100', 'hex')) + 20;
		while (data.readUInt16BE(field) !== 0x3f0a) field += 4 + data.readUInt16BE(field + 2);
		const entrySize = data.readUInt32BE(field + 8);
		data[field + 12 + 25 * entrySize + 1] = 256 - 25;
		using input = new Input({ source: new BufferSource(data), formats: [MXF] });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		await expect(sink.getSample(24 / 25)).rejects.toThrow('dependency skips an intervening GOP');
	});

	it('should emit initial closed-GOP leading pictures and every later picture through range iteration', async () => {
		registerMpeg2Decoder();
		using input = new Input({ source: source(), formats: [MXF] });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		let i = 0;
		for await (const sample of sink.samples()) {
			try {
				await verify(sample, i++);
			} finally {
				sample.close();
			}
		}
		expect(i).toBe(36);
	});

	it('should retain later requested leading Bs while applying only initial header preroll', async () => {
		registerMpeg2Decoder();
		using input = new Input({ source: source(), formats: [MXF] });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		const targets = [0, 1, 17, 24, 25, 26, 0, 24, 24, 35];
		let i = 0;
		for await (const sample of sink.samplesAtTimestamps(targets.map(x => x / 25))) {
			expect(sample).not.toBeNull();
			try {
				await verify(sample!, targets[i++]!);
			} finally {
				sample?.close();
			}
		}
		expect(i).toBe(targets.length);
	});

	it('should preserve a cold range starting at requested leading B pictures', async () => {
		registerMpeg2Decoder();
		using input = new Input({ source: source(), formats: [MXF] });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		let i = 24;
		for await (const sample of sink.samples(24 / 25, 28 / 25)) {
			try {
				await verify(sample, i++);
			} finally {
				sample.close();
			}
		}
		expect(i).toBe(28);
	});

	it('should cancel leading-header proof without poisoning a later cold selection', async () => {
		registerMpeg2Decoder();
		const data = readFileSync(new URL('../fixtures/mpeg2/open/open422.mxf', import.meta.url));
		const target = Number(manifest.packets[13]!.pos) + 20;
		let entered!: () => void;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pause = true;
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => data.length, maxCacheSize: 0, prefetchProfile: 'none',
			read: async (start, end) => {
				if (pause && start <= target && end > target) {
					pause = false;
					entered();
					await gate;
				}
				return data.subarray(start, end);
			},
		}) });
		const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
		const controller = new AbortController();
		const pending = sink.getSample(17 / 25, { signal: controller.signal });
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await blocked;
		controller.abort();
		release();
		await rejected;
		using sample = (await sink.getSample(17 / 25))!;
		await verify(sample, 17);
	});
});
