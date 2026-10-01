import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ALL_FORMATS, AudioSampleSink, BufferSource, CustomSource, EncodedPacketSink,
	Input, LXF, MXF, VideoSampleSink } from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import { lxfChecksum, lxfEnvelope, lxfFixture, pcmValue } from './lxf-fixture.js';

// Authored FFmpeg 7.1.1 testsrc2, six 96x64 pictures at 25 fps; no source-movie bytes.
// Encode: ffmpeg -f lavfi -i testsrc2=size=96x64:rate=25 -frames:v 6 -c:v mpeg2video
// -pix_fmt yuv422p -profile:v 0 -level:v 2 -g 1 -bf 0 -flags:v +cgop+bitexact
// -sc_threshold 1000000000 -q:v 4 -threads:v 1 -fflags +bitexact -f mpeg2video lxf-changing422.m2v
// Reference: ffmpeg -idct faani -i lxf-changing422.m2v -pix_fmt yuv422p -f framehash -hash sha256 -
// Tests wrap the unmodified elementary pictures in authored LXF envelopes, not producer-recorded containers.

describe('given authored version-1 LXF with a nonzero common origin', () => {
	describe('when audio ends more than 32 video envelopes before EOF', () => {
		it('should agree on the audio endpoint across duration, packet and decoded-sample iteration', async () => {
			const fixture = lxfFixture(34, 0, false, 0, undefined, { audioFrameCount: 1 });
			using input = new Input({ formats: [LXF], source: new BufferSource(fixture.read(0, fixture.size)) });
			const audio = (await input.getPrimaryAudioTrack())!;
			const sink = new EncodedPacketSink(audio);
			const first = (await sink.getFirstPacket())!;
			expect(await sink.getNextPacket(first)).toBeNull();
			expect(await audio.getDurationFromMetadata()).toBe(0.04);
			expect(await audio.computeDuration()).toBe(0.04);
			const packets = [];
			for await (const packet of sink.packets()) {
				packets.push([packet.timestamp, packet.duration, packet.byteLength]);
			}
			expect(packets).toEqual([[0, 0.04, 46080]]);
			const samples = [];
			for await (const sample of new AudioSampleSink(audio).samples()) {
				using owned = sample;
				samples.push([owned.timestamp, owned.duration, owned.numberOfFrames]);
			}
			expect(samples).toEqual([[0, 0.04, 1920]]);
		});

		it('should keep rejecting exhausted traversal when the proved tail contains another audio packet', async () => {
			const fixture = lxfFixture(34, 0, false, 0, undefined, { audioFrameCount: 1 });
			const data = Buffer.concat([fixture.read(0, fixture.size),
				lxfEnvelope(1, 33 * 28800, 28800, fixture.audio.length), fixture.audio]);
			using input = new Input({ formats: [LXF], source: new BufferSource(data) });
			const audio = (await input.getPrimaryAudioTrack())!;
			expect(await audio.getDurationFromMetadata()).toBe(34 / 25);
			const sink = new EncodedPacketSink(audio);
			const first = (await sink.getFirstPacket())!;
			await expect(sink.getNextPacket(first)).rejects.toThrow('next-packet envelope budget exhausted');
		});
	});

	describe('when seeking independently encoded changing I pictures and PCM', () => {
		it('should select exact packet content and FFmpeg pixels after cold, backward and repeated seeks', async () => {
			registerMpeg2Decoder();
			const elementary = readFileSync(new URL('../public/lxf-changing422.m2v', import.meta.url));
			const videoPackets: Buffer[] = [];
			for (let start = 0; start < elementary.length;) {
				const next = elementary.indexOf(Buffer.from('000001b3', 'hex'), start + 4);
				const end = next === -1 ? elementary.length : next;
				videoPackets.push(elementary.subarray(start, end));
				start = end;
			}
			const audioPackets = Array.from({ length: 6 }, (_, ordinal) => {
				const bytes = Buffer.alloc(2 * 5760);
				for (let s = 0; s < 1920; s++) {
					bytes.writeIntLE((ordinal + 1) * 100000 + s, s * 3, 3);
					bytes.writeIntLE(-((ordinal + 1) * 100000 + 10000 + s), 5760 + s * 3, 3);
				}
				return bytes;
			});
			const fixture = lxfFixture(6, 0, true, 0, ordinal => ordinal * 200000,
				{ channels: 2, audioFrameCount: 6, videoPackets, audioPackets });
			using input = new Input({ formats: [LXF], source: new CustomSource({
				getSize: () => fixture.size, prefetchProfile: 'none', maxCacheSize: 0, read: fixture.read,
			}) });
			const video = (await input.getPrimaryVideoTrack())!;
			const audio = (await input.getPrimaryAudioTrack())!;
			const encodedVideo = new EncodedPacketSink(video);
			const encodedAudio = new EncodedPacketSink(audio);
			const decodedVideo = new VideoSampleSink(video);
			const decodedAudio = new AudioSampleSink(audio);
			// FFmpeg 7.1.1 FAANI on the original elementary stream, not this decoder's output.
			const pixelHashes = [
				'9735ce88ac1cddefb9324df4d09848991b3b176f1c679c1885258ba465737244',
				'67d85d69717bcfc1c151287e4deb13ee8a7815cf57b5d2484b1f7acad64255df',
				'216a6a79ecc826c8136da6222d21c9471295a6de7670f33e9329e474946f9016',
				'9578b233d3c6c70d999ac7d2aaea25ce3c37900ea392914fc1f82af3a488952a',
				'78e7abac2a7d0ce3571795427345e1d1d15516246d22caa1d6ae7c040303d9d9',
				'0de4890060df1b3b45f998019daf653b89477df6d7f4af31a962bb21c8a4c61c',
			];
			for (const ordinal of [4, 1, 5, 0, 3, 3, 2]) {
				const timestamp = ordinal / 25;
				const packet = (await encodedVideo.getPacket(timestamp))!;
				expect([packet.timestamp, packet.duration, packet.sequenceNumber]).toEqual([timestamp, 0.04, ordinal]);
				expect(packet.data).toEqual(new Uint8Array(videoPackets[ordinal]!));
				using picture = (await decodedVideo.getSample(timestamp))!;
				expect([picture.timestamp, picture.format, picture.scan, picture.codedWidth, picture.codedHeight])
					.toEqual([timestamp, 'I422', 'progressive', 96, 64]);
				const pixels = new Uint8Array(picture.allocationSize());
				await picture.copyTo(pixels);
				expect(createHash('sha256').update(pixels).digest('hex')).toBe(pixelHashes[ordinal]);
				const pcm = (await encodedAudio.getPacket(timestamp))!;
				expect([pcm.timestamp, pcm.duration, pcm.sequenceNumber]).toEqual([timestamp, 0.04, ordinal]);
				const bytes = Buffer.from(pcm.data);
				using samples = (await decodedAudio.getSample(timestamp))!;
				expect([samples.timestamp, samples.numberOfFrames, samples.numberOfChannels])
					.toEqual([timestamp, 1920, 2]);
				for (let channel = 0; channel < 2; channel++) {
					const plane = new Float32Array(1920);
					samples.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
					for (let s = 0; s < 1920; s++) {
						const expected = channel === 0
							? (ordinal + 1) * 100000 + s
							: -((ordinal + 1) * 100000 + 10000 + s);
						expect(bytes.readIntLE((s * 2 + channel) * 3, 3)).toBe(expected);
						expect(plane[s]).toBe(expected / 8388608);
					}
				}
			}
		});
	});

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
			for (let i = 1; i < 5; i++) {
				packet = (await sink.getNextPacket(packet))!;
			}
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
		if (extra) {
			await expect(track.computeDuration()).rejects.toThrow('per-track endpoint absent');
		} else {
			expect(await track.computeDuration()).toBe(3.24);
		}
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
			if (stage === 'resync') {
				await track.getDurationFromMetadata();
			}
			const sink = new EncodedPacketSink(track);
			const controller = new AbortController();
			armed = true;
			const pending = stage === 'audio'
				? sink.getFirstPacket({ signal: controller.signal })
				: sink.getPacket(4.281, { signal: controller.signal });
			let settled = false;
			void pending.then(() => {
				settled = true;
			}, () => {
				settled = true;
			});
			const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
			await blocked;
			const before = reads;
			controller.abort();
			try {
				await expect.poll(() => settled, { timeout: 1000 }).toBe(true);
			} finally {
				release();
				await rejected;
			}
			expect(reads).toBe(before);
			const retry = stage === 'audio'
				? (await sink.getFirstPacket())!
				: (await sink.getPacket(4.281))!;
			expect(retry.timestamp).toBe(stage === 'audio' ? 3 : 4.28);
			if (stage === 'audio') {
				expect(Buffer.from(retry.data).readIntLE(0, 3)).toBe(-8388608);
			}
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
				if (end - start === 1024 * 1024) {
					windows++;
				}
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
		using input = new Input({ formats: [...ALL_FORMATS, LXF],
			source: new BufferSource(fixture.read(0, fixture.size)) });
		expect(await input.getFormat()).toBe(LXF);
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
		expect(createHash('sha256').update(pixels).digest('hex')).toBe(fixture.golden);
		expect([sample.timestamp, sample.duration, sample.format, sample.scan])
			.toEqual([(fixture.origin + 3 * 28800) / 720000, 0.04, 'I422', 'progressive']);
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
			for (let s = 0; s < values.length; s++) {
				expect(values[s]).toBe(pcmValue(s, c) / 8388608);
			}
		}
		let count = 0;
		for await (const p of new EncodedPacketSink(video).packets()) {
			expect(p.data).toEqual(new Uint8Array(fixture.video));
			expect([p.sequenceNumber, p.timestamp, p.duration])
				.toEqual([count, (fixture.origin + count * 28800) / 720000, 0.04]);
			count++;
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
			if (kind === 'checksum') {
				header[64] = header[64]! ^ 1;
			}
			if (kind === 'version') {
				header.writeUInt32LE(0, 8);
			}
			if (kind === 'precision') {
				header.writeUInt32LE(0x518, 40);
			}
			if (kind === 'mask') {
				header.writeUInt32LE(0x81, 44);
			}
			if (kind === 'unsafe ticks') {
				header.writeBigUInt64LE(2n ** 63n, 24);
			}
			if (kind === 'duration') {
				header.writeBigUInt64LE(0n, 32);
			}
			if (kind === 'unknown type') {
				header.writeUInt32LE(7, 16);
			}
			if (kind === 'stream ID') {
				header.writeUInt32LE(1, 20);
			}
			if (kind === 'reordered video') {
				header.writeUInt32LE(0x105013, 40);
			}
			if (kind === 'zero video') {
				header.writeUInt32LE(0, 44);
			}
			if (kind === 'oversized video') {
				header.writeUInt32LE(8 * 1024 * 1024, 44);
			}
			if (kind !== 'checksum') {
				lxfChecksum(header);
			}
			using input = new Input({ formats: [LXF], source: new BufferSource(data) });
			await expect(input.getTracks()).rejects.toThrow(/LXF/);
		},
	);

	it('should reject a truncated final envelope without shortening the declared timeline', async () => {
		const fixture = lxfFixture();
		using input = new Input({ formats: [LXF], source: new BufferSource(fixture.read(0, fixture.size - 1)) });
		await expect((await input.getPrimaryVideoTrack())!.computeDuration()).rejects.toThrow(/bounded tail/);
	});

	it.each(['audio', 'video'])('should reject a segment missing its %s track', async (missing) => {
		const fixture = lxfFixture(2);
		const data = fixture.read(0, fixture.size);
		const file = missing === 'audio'
			? Buffer.concat([data.subarray(0, fixture.audioOffsets[0]), data.subarray(fixture.videoOffsets[1])])
			: Buffer.concat([data.subarray(0, fixture.videoOffsets[0]),
					data.subarray(fixture.audioOffsets[0], fixture.videoOffsets[1])]);
		using input = new Input({ formats: [LXF], source: new BufferSource(file) });
		await expect(input.getTracks()).rejects.toThrow(/LXF/);
	});

	it('should validate only a bounded video prefix and no PCM payload for metadata-only packets', async () => {
		const fixture = lxfFixture();
		const original = fixture.read(0, fixture.size);
		const padding = Buffer.alloc(100000);
		const data = Buffer.concat([original.subarray(0, fixture.audioOffsets[0]), padding,
			original.subarray(fixture.audioOffsets[0])]);
		const header = data.subarray(fixture.videoOffsets[0], fixture.videoOffsets[0]! + 72);
		header.writeUInt32LE(fixture.video.length + padding.length, 44);
		lxfChecksum(header);
		let bytes = 0;
		using input = new Input({ formats: [LXF], source: new CustomSource({
			getSize: () => data.length, prefetchProfile: 'none', maxCacheSize: 0,
			read: (from, to) => {
				bytes += to - from;
				return data.subarray(from, to);
			},
		}) });
		const video = (await input.getPrimaryVideoTrack())!;
		const audio = (await input.getPrimaryAudioTrack())!;
		bytes = 0;
		const packet = (await new EncodedPacketSink(video).getFirstPacket({ metadataOnly: true }))!;
		expect([packet.isMetadataOnly, packet.byteLength]).toEqual([true, fixture.video.length + padding.length]);
		expect(bytes).toBeLessThanOrEqual(512);
		bytes = 0;
		const pcm = (await new EncodedPacketSink(audio).getFirstPacket({ metadataOnly: true }))!;
		expect([pcm.isMetadataOnly, pcm.byteLength]).toEqual([true, 46080]);
		expect(bytes).toBe(0);
	});

	it.each([{ name: 'ALL_FORMATS', formats: ALL_FORMATS }, { name: 'MXF', formats: [MXF] }])(
		'should require explicit LXF opt-in with $name', async ({ formats }) => {
			const fixture = lxfFixture();
			using input = new Input({ formats, source: new BufferSource(fixture.read(0, fixture.size)) });
			await expect(input.getTracks()).rejects.toThrow();
		},
	);

	describe('when extracting fewer than eight channel planes', () => {
		it.each([1, 2, 3, 4, 5, 6, 7])('should preserve all %i channel ordinals and PCM triplets', async (channels) => {
			const fixture = lxfFixture(2, 0, false, 0, undefined, { channels });
			using input = new Input({ formats: [LXF], source: new BufferSource(fixture.read(0, fixture.size)) });
			const audio = (await input.getPrimaryAudioTrack())!;
			expect(await audio.getDecoderConfig()).toMatchObject({ codec: 'pcm-s24', sampleRate: 48000,
				numberOfChannels: channels });
			const sink = new EncodedPacketSink(audio);
			const packet = (await sink.getFirstPacket())!;
			expect(packet.byteLength).toBe(5760 * channels);
			const bytes = Buffer.from(packet.data);
			for (let s = 0; s < 1920; s++) {
				for (let c = 0; c < channels; c++) {
					expect(bytes.readIntLE((s * channels + c) * 3, 3)).toBe(pcmValue(s, c));
				}
			}
			const metadata = (await sink.getFirstPacket({ metadataOnly: true }))!;
			expect([metadata.isMetadataOnly, metadata.byteLength, metadata.timestamp, metadata.duration])
				.toEqual([true, packet.byteLength, 0, 0.04]);
		});
	});

	describe('when decoding woven interlaced frame pictures', () => {
		it('should retain I422 pixels and native field order without deinterlacing', async () => {
			registerMpeg2Decoder();
			const fixture = lxfFixture(6, 0, false, 0, undefined, { interlaced: true });
			using input = new Input({ formats: [LXF], source: new BufferSource(fixture.read(0, fixture.size)) });
			const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
			using sample = (await sink.getSample(3 / 25))!;
			using clone = sample.clone();
			input.dispose();
			expect([clone.timestamp, clone.duration, clone.format, clone.scan, clone.codedWidth, clone.codedHeight])
				.toEqual([3 / 25, 1 / 25, 'I422', 'interlaced-top-first', 64, 48]);
			const pixels = new Uint8Array(clone.allocationSize());
			await clone.copyTo(pixels);
			expect(createHash('sha256').update(pixels).digest('hex')).toBe(fixture.golden);
		});
	});
});
