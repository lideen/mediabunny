import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ALL_FORMATS, AudioSampleSink, BufferSource, CustomSource, EncodedPacketSink,
	Input, LXF, MXF, VideoSampleSink } from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import { lxfChecksum, lxfEnvelope, lxfFixture, pcmValue } from './lxf-fixture.js';
import regression from '../fixtures/mpeg2/wasm-idct-v1.json' with { type: 'json' };

describe('given authored version-1 LXF with a nonzero common origin', () => {
	it('should exclude every embedded candidate in a known ancillary extent during later navigation', async () => {
		const fixture = lxfFixture(2, 2160000, true, 0, ordinal => ordinal === 0 ? 1300000 : 0);
		const data = fixture.read(0, fixture.size);
		const start = fixture.size - 1024 * 1024;
		expect(start).toBeGreaterThan(fixture.videoOffsets[0]! + 72);
		expect(start + 1000).toBeLessThan(fixture.audioOffsets[0]! - fixture.video.length);
		data.set(Buffer.from('LEITCH\0\0'), start + 100);
		data.set(lxfEnvelope(0, fixture.origin, 28800, 100), start + 300);
		data.set(lxfEnvelope(0, fixture.origin, 28800, 100), start + 472);
		data.set(lxfEnvelope(2, fixture.origin, 28800, 120), start + 700);
		let bytes = 0;
		using input = new Input({ formats: [LXF], source: new CustomSource({
			getSize: () => data.length, prefetchProfile: 'none', maxCacheSize: 0,
			read: (from, to) => {
				bytes += to - from;
				return data.subarray(from, to);
			},
		}) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		expect((await sink.getFirstPacket())!.data).toEqual(new Uint8Array(fixture.video));
		const selected = (await sink.getPacket(3.04))!;
		expect(selected.timestamp).toBe(3.04);
		expect(selected.data).toEqual(new Uint8Array(fixture.video));
		expect(bytes).toBeLessThan(2 * 1024 * 1024);
	});

	it('should ignore an unproved segment signature inside previously unvisited ancillary bytes', async () => {
		const fixture = lxfFixture(3, 2160000, true, 0, ordinal => ordinal === 1 ? 1300000 : 0);
		const data = fixture.read(0, fixture.size);
		const start = fixture.size - 1024 * 1024;
		data.set(lxfEnvelope(2, fixture.origin, 28800, 120), start + 100);
		using input = new Input({ formats: [LXF], source: new BufferSource(data) });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.computeDuration()).toBe(3.12);
	});

	it('should not recover an EOF suffix after a repeated segment at a predicted boundary', async () => {
		const fixture = lxfFixture(4, 2160000, true, 0, ordinal => ordinal === 1 ? 1300000 : 0);
		const data = fixture.read(0, fixture.size);
		const at = fixture.videoOffsets[2]!;
		const unsupported = data.subarray(at, at + 72);
		unsupported.writeUInt32LE(0x105013, 40);
		lxfChecksum(unsupported);
		const second = Buffer.concat([lxfEnvelope(2, fixture.origin, 28800, 120), Buffer.alloc(120)]);
		const file = Buffer.concat([data.subarray(0, at), second, data.subarray(at)]);
		const tailStart = file.length - 1024 * 1024;
		expect(tailStart).toBeGreaterThan(fixture.videoOffsets[1]! + 72);
		expect(tailStart).toBeLessThan(fixture.audioOffsets[1]! - fixture.video.length);
		using input = new Input({ formats: [LXF], source: new BufferSource(file) });
		const track = (await input.getPrimaryVideoTrack())!;
		await expect(track.computeDuration()).rejects.toThrow('multiple segments');
	});

	it.each(['duration', 'traversal'])('should reject a second segment during %s', async (operation) => {
		const fixture = lxfFixture();
		const data = fixture.read(0, fixture.size);
		const at = fixture.videoOffsets.at(-1)!;
		const second = Buffer.concat([lxfEnvelope(2, fixture.origin, 28800, 120), Buffer.alloc(120)]);
		using input = new Input({ formats: [LXF],
			source: new BufferSource(Buffer.concat([data.subarray(0, at), second, data.subarray(at)])) });
		const track = (await input.getPrimaryVideoTrack())!;
		if (operation === 'duration') {
			await expect(track.computeDuration()).rejects.toThrow('multiple segments');
		} else {
			const sink = new EncodedPacketSink(track);
			let packet = (await sink.getFirstPacket())!;
			for (let i = 1; i < 5; i++) packet = (await sink.getNextPacket(packet))!;
			await expect(sink.getNextPacket(packet)).rejects.toThrow('multiple segments');
		}
	});

	it.each([false, true])('should reject later sequence changes with metadataOnly=%s', async (metadataOnly) => {
		const fixture = lxfFixture();
		const data = fixture.read(0, fixture.size);
		const sequence = fixture.video.indexOf(Buffer.from('000001b3', 'hex'));
		const byte = fixture.videoOffsets[2]! + 72 + sequence + 4;
		data[byte] = data[byte]! ^ 1;
		using input = new Input({ formats: [LXF], source: new BufferSource(data) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		await expect(sink.getPacket((fixture.origin + 2 * 28800) / 720000, { metadataOnly }))
			.rejects.toThrow('configuration changed');
	});

	it('should include every declared word in an extended header checksum', async () => {
		const fixture = lxfFixture();
		const data = fixture.read(0, fixture.size);
		const header = Buffer.alloc(256);
		header.set(data.subarray(0, 72));
		header.writeUInt32LE(256, 12);
		header.writeUInt32LE(0x11223344, 252);
		lxfChecksum(header);
		using input = new Input({ formats: [LXF],
			source: new BufferSource(Buffer.concat([header, data.subarray(72)])) });
		const track = (await input.getPrimaryVideoTrack())!;
		expect((await new EncodedPacketSink(track).getFirstPacket())!.data).toEqual(new Uint8Array(fixture.video));
		header[255] = header[255]! ^ 1;
		using corrupt = new Input({ formats: [LXF],
			source: new BufferSource(Buffer.concat([header, data.subarray(72)])) });
		await expect(corrupt.getTracks()).rejects.toThrow('checksum');
	});

	it.each([0, 1])('should enforce the tail window with %i bytes of missing endpoint coverage', async (extra) => {
		const videoSize = lxfFixture().video.length;
		const lastAncillary = 1024 * 1024 - (72 + 46080) - 72 - videoSize + extra;
		const fixture = lxfFixture(6, 2160000, true, lastAncillary);
		let bytes = 0;
		using input = new Input({ formats: [LXF], source: new CustomSource({
			getSize: () => fixture.size, prefetchProfile: 'none', maxCacheSize: 0,
			read: (start, end) => {
				bytes += end - start;
				return fixture.read(start, end);
			},
		}) });
		const track = (await input.getPrimaryVideoTrack())!;
		if (extra) await expect(track.computeDuration()).rejects.toThrow('per-track endpoint absent');
		else expect(await track.computeDuration()).toBe(3.24);
		expect(bytes).toBeLessThan(2 * 1024 * 1024);
	});

	it.each(['tail', 'resync', 'audio'] as const)(
		'should cancel during %s I/O without caching a failed operation or modifying PCM bytes', async (stage) => {
			const fixture = lxfFixture(64, 2160000, true);
			let armed = false;
			let entered!: () => void;
			let release!: () => void;
			const blocked = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let reads = 0;
			using input = new Input({ formats: [LXF], source: new CustomSource({
				getSize: () => fixture.size, prefetchProfile: 'none', maxCacheSize: 0,
				read: async (start, end) => {
					reads++;
					const audioStart = fixture.audioOffsets[0]! + 72;
					const selected = stage === 'audio'
						? start < audioStart + 46080 && end > audioStart
						: end - start === 1024 * 1024;
					if (armed && selected) {
						armed = false;
						entered();
						await gate;
					}
					return fixture.read(start, end);
				},
			}) });
			const track = stage === 'audio'
				? (await input.getPrimaryAudioTrack())!
				: (await input.getPrimaryVideoTrack())!;
			if (stage === 'resync') await track.getDurationFromMetadata();
			const sink = new EncodedPacketSink(track);
			const controller = new AbortController();
			armed = true;
			const pending = stage === 'audio'
				? sink.getFirstPacket({ signal: controller.signal })
				: sink.getPacket(4.281, { signal: controller.signal });
			const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
			await blocked;
			const before = reads;
			controller.abort();
			release();
			await rejected;
			expect(reads).toBe(before);
			const retry = stage === 'audio'
				? (await sink.getFirstPacket())!
				: (await sink.getPacket(4.281))!;
			expect(retry.timestamp).toBe(stage === 'audio' ? 3 : 4.28);
			if (stage === 'audio') expect(Buffer.from(retry.data).readIntLE(0, 3)).toBe(-8388608);
		},
	);

	it('should reject missing wire intervals instead of returning future pictures', async () => {
		const fixture = lxfFixture();
		const data = fixture.read(0, fixture.size);
		for (const offset of [fixture.videoOffsets[2]!, fixture.audioOffsets[2]!]) {
			const header = data.subarray(offset, offset + 72);
			header.writeBigUInt64LE(BigInt(fixture.origin + 3 * 28800), 24);
			lxfChecksum(header);
		}
		using input = new Input({ formats: [LXF], source: new BufferSource(data) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		await expect(sink.getPacket((fixture.origin + 2 * 28800) / 720000)).rejects.toThrow(/LXF/);
	});

	it('should exhaust the seek budget on a skewed layout instead of returning an approximate packet', async () => {
		const fixture = lxfFixture(10000, 0, true, 500000, ordinal => ordinal < 9000 ? 0 : 800000);
		let bytes = 0;
		let windows = 0;
		using input = new Input({ formats: [LXF], source: new CustomSource({
			getSize: () => fixture.size, prefetchProfile: 'none', maxCacheSize: 0,
			read: (start, end) => {
				bytes += end - start;
				if (end - start === 1024 * 1024) windows++;
				return fixture.read(start, end);
			},
		}) });
		const track = (await input.getPrimaryVideoTrack())!;
		await track.getDurationFromMetadata();
		bytes = 0;
		windows = 0;
		await expect(new EncodedPacketSink(track).getPacket(8900 / 25))
			.rejects.toThrow('navigation byte budget exhausted');
		expect(bytes).toBeLessThanOrEqual(12 * 1024 * 1024);
		expect(windows).toBeLessThanOrEqual(12);
	});

	it('should preserve wire timing, separate endpoints, owned video and eight distinct PCM channels', async () => {
		registerMpeg2Decoder();
		const fixture = lxfFixture();
		const data = fixture.read(0, fixture.size);
		expect(createHash('sha256').update(data).digest('hex')).toBe(regression.cases.lxf.inputSha256);
		using input = new Input({ formats: [...ALL_FORMATS, MXF, LXF],
			source: new BufferSource(data) });
		expect(await input.getFormat()).toBe(LXF);
		expect(ALL_FORMATS).not.toContain(LXF);
		const video = (await input.getPrimaryVideoTrack())!;
		const audio = (await input.getPrimaryAudioTrack())!;
		expect(await video.getFirstTimestamp()).toBe(fixture.origin / 720000);
		expect(await video.getDurationFromMetadata()).toBe((fixture.origin + 6 * 28800) / 720000);
		expect(await audio.computeDuration()).toBe((fixture.origin + 5 * 28800) / 720000);
		expect(await audio.getNumberOfChannels()).toBe(8);
		expect(await new VideoSampleSink(video).getSample(0)).toBeNull();
		using sample = (await new VideoSampleSink(video).getSample((fixture.origin + 3 * 28800) / 720000))!;
		const pixels = new Uint8Array(sample.allocationSize());
		await sample.copyTo(pixels);
		expect(createHash('sha256').update(pixels).digest('hex')).toBe(regression.cases.lxf.frames[0]!.sha256);
		expect(sample.timestamp).toBe((fixture.origin + 3 * 28800) / 720000);
		const packets = new EncodedPacketSink(audio);
		const packet = (await packets.getFirstPacket())!;
		for (let s = 0; s < 1920; s++) {
			for (let c = 0; c < 8; c++) {
				expect(Buffer.from(packet.data).readIntLE((s * 8 + c) * 3, 3)).toBe(pcmValue(s, c));
			}
		}
		packet.data.fill(0);
		expect((await packets.getFirstPacket())!.data[2]).toBe(128);
		using decoded = (await new AudioSampleSink(audio).getSample(fixture.origin / 720000))!;
		for (let c = 0; c < 8; c++) {
			const values = new Float32Array(1920);
			decoded.copyTo(values, { planeIndex: c, format: 'f32-planar' });
			for (let s = 0; s < values.length; s++) expect(values[s]).toBe(pcmValue(s, c) / 8388608);
		}
		let count = 0;
		for await (const p of new EncodedPacketSink(video).packets()) {
			expect(p.data).toEqual(new Uint8Array(fixture.video));
			expect(p.sequenceNumber).toBe(count++);
		}
		expect(count).toBe(6);
	});

	it('should seek an over-8-GB logical variable-size file within finite read budgets', async () => {
		const fixture = lxfFixture(10000, 3 * 720000 + 123, true);
		expect(fixture.size).toBeGreaterThan(8e9);
		let bytes = 0;
		using input = new Input({ formats: [LXF], source: new CustomSource({
			getSize: () => fixture.size, prefetchProfile: 'none', maxCacheSize: 0,
			read: (start, end) => {
				bytes += end - start;
				expect(bytes).toBeLessThan(16 * 1024 * 1024);
				return fixture.read(start, end);
			},
		}) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		for (const ordinal of [5000, 9998, 0]) {
			bytes = 0;
			const packet = (await sink.getPacket((fixture.origin + ordinal * 28800 + 100) / 720000))!;
			expect(packet.sequenceNumber).toBe(ordinal);
			expect(packet.data).toEqual(new Uint8Array(fixture.video));
		}
	});

	it.each(['checksum', 'version', 'precision', 'mask', 'unsafe ticks', 'duration',
		'unknown type', 'stream ID', 'reordered video', 'zero video', 'oversized video'])(
		'should reject %s rather than guess timing or channel layout', async (kind) => {
			const fixture = lxfFixture();
			const data = fixture.read(0, fixture.size);
			const at = ['precision', 'mask'].includes(kind)
				? fixture.audioOffsets[0]!
				: kind.includes('video') ? fixture.videoOffsets[0]! : 0;
			const header = data.subarray(at, at + 72);
			if (kind === 'checksum') header[64] = header[64]! ^ 1;
			if (kind === 'version') header.writeUInt32LE(0, 8);
			if (kind === 'precision') header.writeUInt32LE(0x518, 40);
			if (kind === 'mask') header.writeUInt32LE(0x81, 44);
			if (kind === 'unsafe ticks') header.writeBigUInt64LE(2n ** 63n, 24);
			if (kind === 'duration') header.writeBigUInt64LE(0n, 32);
			if (kind === 'unknown type') header.writeUInt32LE(7, 16);
			if (kind === 'stream ID') header.writeUInt32LE(1, 20);
			if (kind === 'reordered video') header.writeUInt32LE(0x105013, 40);
			if (kind === 'zero video') header.writeUInt32LE(0, 44);
			if (kind === 'oversized video') header.writeUInt32LE(8 * 1024 * 1024, 44);
			if (kind !== 'checksum') lxfChecksum(header);
			using input = new Input({ formats: [LXF], source: new BufferSource(data) });
			await expect(input.getTracks()).rejects.toThrow(/LXF/);
		},
	);

	it('should reject a truncated final envelope without shortening the declared timeline', async () => {
		const fixture = lxfFixture();
		using input = new Input({ formats: [LXF], source: new BufferSource(fixture.read(0, fixture.size - 1)) });
		await expect((await input.getPrimaryVideoTrack())!.computeDuration()).rejects.toThrow(/bounded tail/);
	});

	it('should not recognize LXF as MXF even when the caller supplies only MXF', async () => {
		const fixture = lxfFixture();
		using input = new Input({ formats: [MXF], source: new BufferSource(fixture.read(0, fixture.size)) });
		await expect(input.getTracks()).rejects.toThrow();
	});
});
