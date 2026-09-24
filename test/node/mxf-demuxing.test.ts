import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Input, InputDisposedError } from '../../src/input.js';
import { ALL_FORMATS, MXF } from '../../src/input-format.js';
import { BufferSource, CustomSource, FilePathSource, ReadableStreamSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { makeMxf } from './mxf-fixture.js';

describe('given a synthetic finalized OP1a ProRes and PCM file', () => {
	describe('when discovering its tracks', () => {
		it('should expose video and both mono audio tracks without enabling MXF by default', async () => {
			using input = new Input({ source: new BufferSource(makeMxf().data), formats: [MXF] });
			expect(ALL_FORMATS).not.toContain(MXF);
			expect(await input.getFormat()).toBe(MXF);
			const tracks = await input.getTracks();
			expect(tracks.map(track => [track.type, track.id, track.number])).toEqual([
				['video', 1, 1], ['audio', 2, 1], ['audio', 3, 2],
			]);
			expect(await (await input.getPrimaryVideoTrack())!.getDecoderConfig()).toEqual({
				codec: 'apco', codedWidth: 1280, codedHeight: 720,
				colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false },
			});
			expect(await (await input.getPrimaryAudioTrack())!.getDecoderConfig())
				.toEqual({ codec: 'pcm-s24', numberOfChannels: 1, sampleRate: 48000 });
			expect(await input.computeDuration()).toBeCloseTo(0.08341666666666667, 12);
		});

		it('should resolve remapped primer tags and ignore unknown optional descriptor properties', async () => {
			using input = new Input({ source: new BufferSource(makeMxf({ remapTags: true }).data), formats: [MXF] });
			expect((await input.getTracks()).map(track => track.type)).toEqual(['video', 'audio', 'audio']);
			expect(await (await input.getPrimaryVideoTrack())!.getCodec()).toBe('prores');
		});

		it('should match reordered descriptors to source IDs rather than material IDs', async () => {
			using input = new Input({
				source: new BufferSource(makeMxf({ materialIdOffset: 100 }).data), formats: [MXF],
			});
			const tracks = await input.getTracks();
			expect(tracks.map(track => track.id)).toEqual([101, 102, 103]);
			expect(await Promise.all(tracks.map(track => track.getCodec()))).toEqual(['prores', 'pcm-s24', 'pcm-s24']);
			const packets = await Promise.all(tracks.map(track => new EncodedPacketSink(track).getFirstPacket()));
			expect(packets.map(packet => packet!.byteLength)).toEqual([40, 2403, 2403]);
			expect(packets[2]!.data[0]).toBe(10);
		});
	});

	describe('when reading packets concurrently and by timestamp', () => {
		it.each(['initial', 'later', 'both'] as const)(
			'should read packets past leading and counted trailing Fill in %s partitions', async (padding) => {
				const fixture = makeMxf({ padding });
				using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
				expect((await input.getTracks()).map(track => track.type)).toEqual(['video', 'audio', 'audio']);
				const video = (await input.getPrimaryVideoTrack())!;
				const sink = new EncodedPacketSink(video);
				expect((await sink.getFirstPacket())!.data).toEqual(fixture.payloads[0]);
				const packets = [];
				for await (const packet of sink.packets()) packets.push(packet);
				expect(packets.map(packet => packet.data)).toEqual(fixture.payloads);
				expect(packets.map(packet => packet.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
				expect(await video.computeDuration()).toBeCloseTo(5005 / 60000, 12);
				const audio = (await input.getAudioTracks())[1]!;
				expect((await new EncodedPacketSink(audio).getPacket(Infinity))!.data[0]).toBe(14);
			},
		);

		it.each([[48000, 1], [60000, 1001], [120000, 2002]])(
			'should keep the 48 kHz clock with descriptor SampleRate %i/%i', async (numerator, denominator) => {
				using input = new Input({
					source: new BufferSource(makeMxf({ pcmDescriptorRate: [numerator, denominator] }).data),
					formats: [MXF],
				});
				const audio = (await input.getPrimaryAudioTrack())!;
				expect(await audio.getDecoderConfig()).toEqual({
					codec: 'pcm-s24', numberOfChannels: 1, sampleRate: 48000,
				});
				const packets = [];
				for await (const packet of new EncodedPacketSink(audio).packets()) packets.push(packet);
				expect(packets.map(packet => packet.timestamp)).toEqual([
					0, 801 / 48000, 1602 / 48000, 2402 / 48000, 3203 / 48000,
				]);
				expect(packets.map(packet => packet.duration)).toEqual([
					801 / 48000, 801 / 48000, 800 / 48000, 801 / 48000, 801 / 48000,
				]);
			},
		);

		it('should read the first packet without fetching later essence or metadata-only payloads', async () => {
			const fixture = makeMxf();
			const reads: [number, number][] = [];
			using input = new Input({
				source: new CustomSource({
					getSize: () => fixture.data.length,
					read: async (start, end) => {
						reads.push([start, end]);
						return fixture.data.slice(start, end);
					},
				}),
				formats: [MXF],
			});
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const metadata = await sink.getFirstPacket({ metadataOnly: true });
			expect(metadata!.byteLength).toBe(40);
			// The maximum BER header probe includes five bytes past this fixture's three-byte length.
			expect(Math.max(...reads.map(([, end]) => end))).toBeLessThanOrEqual(fixture.firstPayloadOffset + 5);
			const first = await sink.getFirstPacket();
			expect(first!.data).toEqual(fixture.payloads[0]);
			expect(Math.max(...reads.map(([, end]) => end))).toBeLessThanOrEqual(fixture.firstPayloadOffset + 40);
		});

		it('should retain per-track decode order and identical metadata-only packet identity', async () => {
			const fixture = makeMxf();
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const [tracks, sameTracks] = await Promise.all([input.getTracks(), input.getTracks()]);
			expect(sameTracks.map(t => t.id)).toEqual([1, 2, 3]);
			const sink = new EncodedPacketSink(tracks[0]!);
			const [first, metadata] = await Promise.all([
				sink.getFirstPacket(), sink.getFirstPacket({ metadataOnly: true }),
			]);
			expect(first!.data).toEqual(fixture.payloads[0]);
			expect(metadata!.data).toHaveLength(0);
			expect([metadata!.byteLength, metadata!.timestamp, metadata!.duration, metadata!.sequenceNumber])
				.toEqual([40, 0, 1001 / 60000, 0]);
			const next = await sink.getNextPacket(metadata!);
			expect(next!.data).toEqual(fixture.payloads[1]);
			expect(next!.sequenceNumber).toBe(1);
			expect((await sink.getPacket(0.02))!.sequenceNumber).toBe(1);
			expect((await sink.getPacket(Infinity))!.data).toEqual(fixture.payloads[4]);
			expect(await sink.getNextPacket((await sink.getPacket(Infinity))!)).toBeNull();
			expect(await sink.getPacket(-1)).toBeNull();
		});

		it.each([false, true])('should time ST 382 PCM using actual payloads with waveAudio=%s', async (waveAudio) => {
			using input = new Input({ source: new BufferSource(makeMxf({ waveAudio }).data), formats: [MXF] });
			const audio = (await input.getAudioTracks())[0]!;
			const sink = new EncodedPacketSink(audio);
			const packets = [];
			for await (const packet of sink.packets()) packets.push(packet);
			expect(packets.map(p => p.byteLength)).toEqual([2403, 2403, 2400, 2403, 2403]);
			expect(packets.map(p => p.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
			expect(packets[3]!.timestamp).toBe(2402 / 48000);
			expect(packets[2]!.duration).toBe(800 / 48000);
			expect(await audio.computeDuration()).toBeCloseTo(4004 / 48000, 12);
		});

		it('should reject an in-flight packet read after disposal', async () => {
			const fixture = makeMxf();
			let notifyRead!: () => void;
			let releaseRead!: () => void;
			const started = new Promise<void>((resolve) => {
				notifyRead = resolve;
			});
			const released = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
			using input = new Input({
				source: new CustomSource({
					getSize: () => fixture.data.length,
					read: async (start, end) => {
						if (start >= fixture.firstPayloadOffset) {
							notifyRead();
							await released;
						}
						return fixture.data.slice(start, end);
					},
				}), formats: [MXF],
			});
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const pending = expect(sink.getFirstPacket()).rejects.toBeInstanceOf(InputDisposedError);
			await started;
			input.dispose();
			releaseRead();
			await pending;
		});
	});
});

describe('given unsupported or malformed MXF', () => {
	describe('when reading metadata', () => {
		it('should reject a PCM descriptor rate unrelated to the edit or audio sample rate', async () => {
			using input = new Input({
				source: new BufferSource(makeMxf({ pcmDescriptorRate: [25, 1] }).data), formats: [MXF],
			});
			await expect(input.getTracks()).rejects.toThrow(/PCM descriptor sample rate/);
		});

		it.each([
			[{ origin: 1 }, /Origin/], [{ start: 1 }, /StartPosition/],
			[{ layout: 1 }, /interlaced/], [{ blockAlign: 4 }, /PCM packing/],
			[{ unsupportedContainer: true }, /frame wrapping/], [{ externalPackage: true }, /external source/],
			[{ channelSelection: true }, /channel mapping/],
		] as const)('should reject unsupported layout %j', async (options, error) => {
			using input = new Input({ source: new BufferSource(makeMxf(options).data), formats: [MXF] });
			expect(await input.canRead()).toBe(true);
			await expect(input.getTracks()).rejects.toThrow(error);
		});

		it('should reject non-MXF data during probing', async () => {
			using input = new Input({ source: new BufferSource(new Uint8Array(128)), formats: [MXF] });
			expect(await input.canRead()).toBe(false);
		});

		it.each([0x80, 0x89, 0xff])('should reject invalid BER length %i', async (length) => {
			const data = makeMxf().data;
			data[16] = length;
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(input.getTracks()).rejects.toThrow(/BER length/);
		});

		it('should reject truncated KLV values', async () => {
			using input = new Input({ source: new BufferSource(makeMxf().data.subarray(0, 80)), formats: [MXF] });
			await expect(input.getTracks()).rejects.toThrow(/KLV exceeds file/);
		});

		it('should reject an unknown file bound before navigating KLV headers', async () => {
			const prefix = new Uint8Array(32768);
			prefix.set(makeMxf().data.subarray(0, prefix.length));
			using input = new Input({ formats: [MXF], source: new ReadableStreamSource(
				new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(prefix); } }),
			) });
			await expect(input.getTracks()).rejects.toThrow(/known size/);
		});

		it('should reject an unsafe 64-bit BER length before reading its value', async () => {
			const data = makeMxf().data;
			data[16] = 0x88;
			data.fill(0xff, 17, 25);
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(input.getTracks()).rejects.toThrow(/safe range/);
		});
	});
	describe('when routing essence packets', () => {
		it.each([0, 1, 7, 8])('should accept a terminal empty KLV with %i BER extension bytes', async (count) => {
			const fixture = makeMxf();
			const data = new Uint8Array(fixture.data.length + 17 + count);
			data.set(fixture.data);
			data[fixture.data.length + 16] = count ? 0x80 | count : 0;
			using input = new Input({ source: new CustomSource({
				getSize: () => data.length,
				read: (start, end) => {
					expect(end).toBeLessThanOrEqual(data.length);
					return data.slice(start, end);
				},
			}), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			expect((await sink.getPacket(Infinity))!.data).toEqual(fixture.payloads[4]);
		});

		it.each([16, 17, 24])('should reject a terminal truncated KLV header of %i bytes', async (length) => {
			const fixture = makeMxf();
			const data = new Uint8Array(fixture.data.length + length);
			data.set(fixture.data);
			if (length > 16) data[fixture.data.length + 16] = 0x88;
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(Infinity)).rejects.toThrow(/truncated/);
		});

		it.each([4, 6])('should reject %i picture packets declared as five only when reaching EOF', async (count) => {
			const fixture = makeMxf({ videoPacketCount: count });
			using input = new Input({ source: new BufferSource(fixture.data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			expect((await sink.getFirstPacket())!.data).toEqual(fixture.payloads[0]);
			await expect((async () => {
				const packets = [];
				for await (const packet of sink.packets()) packets.push(packet);
				return packets;
			})()).rejects.toThrow(/picture edit-unit count/);
		});

		it('should reject a missing footer when the scan reaches the end', async () => {
			const fixture = makeMxf();
			using input = new Input({
				source: new BufferSource(fixture.data.subarray(0, fixture.footerOffset)), formats: [MXF],
			});
			const track = (await input.getPrimaryVideoTrack())!;
			await expect(new EncodedPacketSink(track).getPacket(Infinity)).rejects.toThrow(/missing footer/);
		});

		it('should not route a matching TrackNumber from the wrong BodySID', async () => {
			using input = new Input({ source: new BufferSource(makeMxf({ wrongBodySid: true }).data), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			await expect(new EncodedPacketSink(track).getFirstPacket()).rejects.toThrow(/unmapped essence/);
		});
	});
});

describe.skipIf(!process.env['MXF_PRORES_FIXTURE'])('given the external FFmpeg Meridian ProRes Proxy sample', () => {
	describe('when extracting its ProRes packets', () => {
		it('should match independently measured packet bytes and metadata', async () => {
			using input = new Input({ source: new FilePathSource(process.env['MXF_PRORES_FIXTURE']!), formats: [MXF] });
			expect((await input.getTracks()).map(t => t.type)).toEqual(['video', 'audio', 'audio']);
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getDecoderConfig()).toMatchObject({ codec: 'apco', codedWidth: 1280, codedHeight: 720 });
			const packets = [];
			for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
			expect(packets).toHaveLength(5);
			expect(packets[0]!.byteLength).toBe(57008);
			expect(packets.map(packet => createHash('sha256').update(packet.data).digest('hex'))).toEqual([
				'5e8b4869435217745d29ebeecda23c5920470f3bbcbb79713ecfe5daf35f98e7',
				'3ddf9f2cd2cf1acf15b88c6e477e9efb2215812149ce45c7ff7d0f76bca9c52b',
				'59ee7f311815c07ebce6c71ff04906e340d9b54c42ee875d1bea9ab232398f6c',
				'a3d49f1e9b137749fa655636e0ee0a9ace2fe4ebebf488e231c0a91827351b65',
				'0534bbdc83fdb4b7edddc5d9388b8560be05a8b17431bd01e00dac18509777e0',
			]);
			expect(packets[4]!.timestamp).toBeCloseTo(4004 / 60000, 12);
			expect((await input.getMetadataTags()).raw?.['mxf.timecode.1']).toEqual({
				start: '4522', roundedBase: '60', dropFrame: '1',
			});
			for (const audio of await input.getAudioTracks()) {
				const audioPackets = [];
				for await (const packet of new EncodedPacketSink(audio).packets()) audioPackets.push(packet);
				expect(audioPackets.map(packet => packet.byteLength)).toEqual([2403, 2403, 2400, 2403, 2403]);
				expect(await audio.computeDuration()).toBeCloseTo(4004 / 48000, 12);
			}
		});
	});
});
