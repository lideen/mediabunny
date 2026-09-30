import { describe, expect, it } from 'vitest';
import { Input, InputDisposedError } from '../../src/input.js';
import { MXF } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, CustomSource, FilePathSource } from '../../src/source.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { makeMxf } from './mxf-fixture.js';
import { fileURLToPath } from 'node:url';

const indexField = (fixture: ReturnType<typeof makeIndexedMxf>, tag: number) => {
	const data = fixture.regions.at(-1)!.data;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 128;
	while (offset < data.length) {
		const length = view.getUint16(offset + 2);
		if (view.getUint16(offset) === tag) {
			return data.subarray(offset + 4, offset + 4 + length);
		}
		offset += 4 + length;
	}
	throw new Error('Missing fixture index field');
};

const makeSps = (chroma: number, depth: number, progressive: boolean, profile = 100, chromaDepth = depth) => {
	const ue = (value: number) => {
		const bits = (value + 1).toString(2);
		return '0'.repeat(bits.length - 1) + bits;
	};
	// High-family profile, 1280x720, no cropping or VUI. Parser fixtures, not decodable slices.
	let bits = ue(0) + ue(chroma) + ue(depth) + ue(chromaDepth) + '00' + ue(0) + ue(0) + ue(0)
		+ ue(4) + '0' + ue(79) + ue(44) + (progressive ? '1' : '00') + '1001';
	bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
	return Uint8Array.of(0x67, profile, 0, 31,
		...Array.from({ length: bits.length / 8 }, (_, i) => Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
};

describe('given frame-wrapped AVC with I0 P3 B1 B2 and a presentation-to-decode index', () => {
	describe('when traversing packets and seeking by presentation time', () => {
		it('should preserve decode sequence while returning presentation predecessors', async () => {
			const fixture = makeIndexedMxf({ avc: true });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.getCodec()).toBe('avc');
			const sink = new EncodedPacketSink(track);
			let packet = (await sink.getFirstPacket({ metadataOnly: true }))!;
			const result = [];
			for (let i = 0; i < 4; i++) {
				result.push([packet.sequenceNumber, packet.timestamp, packet.type]);
				packet = (await sink.getNextPacket(packet, { metadataOnly: true }))!;
			}
			expect(result).toEqual([[0, 0, 'key'], [1, 0.12, 'delta'], [2, 0.04, 'delta'], [3, 0.08, 'delta']]);
			for (const [time, decode] of [[0, 0], [0.04, 2], [0.08, 3], [0.12, 1], [0.16, 4]]) {
				const found = (await sink.getPacket(time!, { metadataOnly: true }))!;
				expect([found.timestamp, found.sequenceNumber]).toEqual([time, decode]);
			}
		});
	});

	describe('when a seek crosses an index segment boundary', () => {
		it('should resolve both temporal directions, IDR preroll and unshifted PCM', async () => {
			const fixture = makeIndexedMxf({ avc: true });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			expect(await track.hasOnlyKeyPackets()).toBe(false);
			const sink = new EncodedPacketSink(track);
			for (const [p, d] of [[1997, 1998], [1998, 1999], [1999, 1997], [2000, 2000]]) {
				const packet = (await sink.getPacket(p! / 25, { metadataOnly: true }))!;
				expect([packet.timestamp, packet.sequenceNumber]).toEqual([p! / 25, d]);
				const next = (await sink.getNextPacket(packet, { metadataOnly: true }))!;
				expect(next.sequenceNumber).toBe(d! + 1);
			}
			const key = (await sink.getKeyPacket(1998 / 25, { metadataOnly: true }))!;
			expect([key.sequenceNumber, key.timestamp]).toEqual([1996, 1996 / 25]);
			expect((await sink.getNextKeyPacket(key, { metadataOnly: true }))!.sequenceNumber).toBe(2000);
			const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			expect((await audio.getPacket(1998 / 25, { metadataOnly: true }))!.sequenceNumber).toBe(1998);
			await expect(audio.getNextPacket(key)).rejects.toThrow(/does not belong/);
			await expect(audio.getNextKeyPacket(key)).rejects.toThrow(/does not belong/);
		});
	});

	describe('when metadata and full packets are requested concurrently', () => {
		it('should preserve metadata/full packet identity without reading payloads for metadata', async () => {
			const fixture = makeIndexedMxf({ avc: true, ber: true });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new EncodedPacketSink(track);
			const [one, two] = await Promise.all([sink.getPacket(390, { metadataOnly: true }),
				sink.getPacket(390, { metadataOnly: true })]);
			expect(one).toEqual(two);
			expect([one!.timestamp, one!.sequenceNumber, one!.type, one!.duration, one!.byteLength])
				.toEqual([390, 9751, 'delta', 0.04, 1048576]);
			for (const [start, end] of fixture.reads) {
				for (let p = 0; p < fixture.offsets.length; p++) {
					const body = fixture.offsets[p]! + 108;
					const bodyEnd = fixture.offsets[p + 1] ?? fixture.footerOffset;
					if (start >= body && start < bodyEnd) {
						const within = (start - body) % fixture.stride;
						expect(within).toBeLessThan(52);
						expect(end - start + within).toBeLessThanOrEqual(57);
					}
				}
			}
			expect(fixture.reads.reduce((sum, [a, b]) => sum + b - a, 0)).toBeLessThan(24000);
			expect(fixture.reads.length).toBeLessThan(40);
			const full = (await sink.getPacket(390))!;
			expect([full.timestamp, full.sequenceNumber, full.type, full.duration, full.byteLength])
				.toEqual([one!.timestamp, one!.sequenceNumber, one!.type, one!.duration, one!.byteLength]);
			expect(full.data[127]).toBe(9751 % 256);
			const config = await track.getDecoderConfig();
			expect(config).toMatchObject({ codec: 'avc1.64001f', codedWidth: 1280, codedHeight: 720 });
			expect(config!.description).toBeUndefined();
			const key = (await sink.getKeyPacket(0.08, { verifyKeyPackets: true }))!;
			expect(key.sequenceNumber).toBe(0);
			expect((await sink.getNextKeyPacket(key, { verifyKeyPackets: true }))!.sequenceNumber).toBe(4);
		});
	});

	describe('when timestamps lie on fractional edit-rate boundaries', () => {
		it('should choose presentation predecessors and stop at the decode-order end', async () => {
			const fixture = makeIndexedMxf({ avc: true, editRate: [30000, 1001] });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			expect(await sink.getPacket(-1)).toBeNull();
			expect(await sink.getKeyPacket(-1)).toBeNull();
			const boundary = 1998 * 1001 / 30000;
			expect((await sink.getPacket(boundary, { metadataOnly: true }))!.sequenceNumber).toBe(1999);
			expect((await sink.getPacket(boundary - 1e-10, { metadataOnly: true }))!.sequenceNumber).toBe(1998);
			const lastPresented = (await sink.getPacket(Infinity, { metadataOnly: true }))!;
			expect([lastPresented.sequenceNumber, lastPresented.timestamp]).toEqual([9997, 9999 * 1001 / 30000]);
			const lastDecoded = (await sink.getPacket(9998 * 1001 / 30000, { metadataOnly: true }))!;
			expect(lastDecoded.sequenceNumber).toBe(9999);
			expect(await sink.getNextPacket(lastDecoded)).toBeNull();
			expect((await sink.getKeyPacket(Infinity, { metadataOnly: true }))!.sequenceNumber).toBe(9996);
		});
	});

	describe('when a later indexed IDR is contradicted by its payload', () => {
		it('should reject full key reads instead of returning a non-IDR access point', async () => {
			const fixture = makeIndexedMxf({ avc: true, avcNonIdrAt: 4 });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			expect((await sink.getKeyPacket(0.20, { metadataOnly: true }))!.sequenceNumber).toBe(4);
			await expect(sink.getKeyPacket(0.20, { verifyKeyPackets: true })).rejects.toThrow(/must contain IDR/);
			const first = (await sink.getFirstPacket())!;
			await expect(sink.getNextKeyPacket(first, { verifyKeyPackets: true })).rejects.toThrow(/must contain IDR/);
		});
	});

	describe('when the temporal index is unsupported or corrupt', () => {
		it.each([[0.28, 5, 251], [5.12, 128, 128]] as const)(
			'should reject a key offset that skips an intervening IDR at %s seconds', async (time, decode, offset) => {
				const fixture = makeIndexedMxf({ avc: true });
				indexField(fixture, 0x3f0a)[8 + decode * 15 + 1] = offset;
				using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
					read: fixture.read }), formats: [MXF] });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getKeyPacket(time, { metadataOnly: true })).rejects.toThrow(/intervening IDR/);
			},
		);

		it.each([
			['overflow', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f0a)[10]! |= 8;
			}],
			['unique inverse', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f0a)[23] = 255;
			}],
			['IDR', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f0a)[10] = 0x80;
			}],
			['picture flags', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f0a)[40] = 0x80;
			}],
			['key frame offset', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f0a)[39] = 1;
			}],
			['temporal index', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f09)[14] = 0;
			}],
		] as const)('should reject %s instead of inventing monotonic timing', async (error, corrupt) => {
			const fixture = makeIndexedMxf({ avc: true });
			corrupt(fixture);
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(0.04, { metadataOnly: true })).rejects.toThrow(error);
		});

		it('should reject a coded packet with no presentation entry', async () => {
			const fixture = makeIndexedMxf({ avc: true });
			indexField(fixture, 0x3f0a)[8] = 1;
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getFirstPacket({ metadataOnly: true })).rejects.toThrow(/unique inverse/);
		});

		it('should reject missing AVC indexes at the metadata boundary', async () => {
			using input = new Input({ source: new BufferSource(makeMxf({ avc: true }).data), formats: [MXF] });
			await expect(input.getPrimaryVideoTrack()).rejects.toThrow(/requires a temporal index/);
		});
	});

	describe('when an index uses strict rather than naive prediction flags', () => {
		it.each([0x01, 0x05, 0x83])('should reject invalid picture flags %i', async (flags) => {
			const fixture = makeIndexedMxf({ avc: true });
			indexField(fixture, 0x3f0a)[8 + 2 * 15 + 2] = flags;
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			for (const metadataOnly of [true, false]) {
				await expect(sink.getPacket(0.04, { metadataOnly })).rejects.toThrow(/picture flags/);
			}
		});

		it.each([0x03, 0x13, 0x23, 0x33, 0x07, 0x17, 0x27, 0x37, 0x02, 0x06])(
			'should preserve metadata and full packet identity for flags %i', async (flags) => {
				const fixture = makeIndexedMxf({ avc: true });
				indexField(fixture, 0x3f0a)[8 + 2 * 15 + 2] = flags;
				using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
					read: fixture.read }), formats: [MXF] });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				for (const metadataOnly of [true, false]) {
					const packet = (await sink.getPacket(0.04, { metadataOnly }))!;
					expect([packet.sequenceNumber, packet.timestamp, packet.type]).toEqual([2, 0.04, 'delta']);
					if (!metadataOnly) {
						expect(packet.data[127]).toBe(2);
					}
				}
			},
		);
	});

	describe('when a later IDR lacks in-band parameter sets', () => {
		it('should reject changed parameter sets on a cold full key seek', async () => {
			const fixture = makeIndexedMxf({ avc: true, avcChangedParametersAt: 4 });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(0.16)).rejects.toThrow(/stable parameter sets/);
		});

		it('should reject a missing index SPS flag without reading the key payload', async () => {
			const fixture = makeIndexedMxf({ avc: true, avcMissingParametersAt: 4 });
			indexField(fixture, 0x3f0a)[8 + 4 * 15 + 2] = 0x84;
			const payload = fixture.offsets[0]! + 108 + 4 * fixture.stride + 52;
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getKeyPacket(0.16, { metadataOnly: true })).rejects.toThrow(/SPS flag/);
			expect(fixture.reads.some(([start, end]) => start < payload + fixture.frameSize && end > payload + 5))
				.toBe(false);
		});

		it('should reject a falsely self-contained index flag when fetching the full key packet', async () => {
			const fixture = makeIndexedMxf({ avc: true, avcMissingParametersAt: 4 });
			const payload = fixture.offsets[0]! + 108 + 4 * fixture.stride + 52;
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			expect((await sink.getKeyPacket(0.16, { metadataOnly: true }))!.sequenceNumber).toBe(4);
			expect(fixture.reads.some(([start, end]) => start < payload + fixture.frameSize && end > payload + 5))
				.toBe(false);
			await expect(sink.getKeyPacket(0.16)).rejects.toThrow(/SPS\/PPS/);
		});
	});

	describe('when decoder configuration is requested outside the native AVC subset', () => {
		it.each([
			[0, 0, 0, true], [1, 0, 0, true], [1, 2, 2, true],
			[2, 1, 1, true], [2, 3, 3, true], [2, 0, 2, true], [2, 2, 0, true], [2, 0, 0, false],
		] as const)(
			'should reject High 4:2:2 chroma %i, luma depth %i, chroma depth %i, progressive %s',
			async (chroma, depth, chromaDepth, progressive) => {
				const fixture = makeIndexedMxf({ avc: true, avcCoding: '060e2b340401010d0401020201316001',
					avcSps: makeSps(chroma, depth, progressive, 122, chromaDepth) });
				using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
					read: fixture.read }), formats: [MXF] });
				const track = (await input.getPrimaryVideoTrack())!;
				await expect(track.getDecoderConfig()).rejects.toThrow(/progressive 8-bit or 10-bit 4:2:2/);
			},
		);

		it.each([[2, 0, true], [1, 2, true], [1, 0, false]] as const)(
			'should reject chroma %i, depth-minus-8 %i, progressive %s', async (chroma, depth, progressive) => {
				const fixture = makeIndexedMxf({ avc: true, avcSps: makeSps(chroma, depth, progressive) });
				using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
					read: fixture.read }), formats: [MXF] });
				const track = (await input.getPrimaryVideoTrack())!;
				await expect(track.getDecoderConfig()).rejects.toThrow(/progressive 8-bit 4:2:0/);
			},
		);
	});

	describe('when input is disposed while an index window is being read', () => {
		it('should reject every pending seek with InputDisposedError', async () => {
			const fixture = makeIndexedMxf({ avc: true, ber: true });
			let pause = false;
			let release!: () => void;
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: async (start, end) => {
					if (pause && start > fixture.footerOffset) {
						entered();
						await gate;
					}
					return fixture.read(start, end);
				} }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			pause = true;
			const first = sink.getPacket(390, { metadataOnly: true });
			const second = sink.getPacket(390.04, { metadataOnly: true });
			const assertions = [expect(first).rejects.toBeInstanceOf(InputDisposedError),
				expect(second).rejects.toBeInstanceOf(InputDisposedError)];
			await blocked;
			input.dispose();
			release();
			await Promise.all(assertions);
		});
	});
});

// Authored testsrc2/sine, FFmpeg 7.1.1/libx264 High 4:2:0. Only the temporal index
// was corrected using decoded-frame order; this is not a producer-conformance sample.
describe('given real AVC in a synthetic corrected-index MXF', () => {
	describe('when reading real Annex B essence', () => {
		it('should match decoded timing and packet hashes', async () => {
			using input = new Input({
				source: new FilePathSource(fileURLToPath(new URL('../public/mxf-avc420.mxf', import.meta.url))),
				formats: [MXF],
			});
			const track = (await input.getPrimaryVideoTrack())!;
			const config = await track.getDecoderConfig();
			expect(config).toMatchObject({ codec: 'avc1.64001f', codedWidth: 320, codedHeight: 192 });
			expect(config!.description).toBeUndefined();
			const sink = new EncodedPacketSink(track);
			let packet = (await sink.getFirstPacket())!;
			// FFmpeg decoded-frame order, not the original muxer's incorrect packet timestamps.
			const order = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 12, 10, 11, 15, 13, 14, 18, 16, 17, 21, 19, 20,
				24, 22, 23, 25, 28, 26, 27, 29];
			// SHA-256 of the ordered lowercase packet SHA-256 strings from ffprobe.
			const videoHashes = createHash('sha256');
			for (const [d, presentation] of order.entries()) {
				expect([packet.sequenceNumber, packet.timestamp, packet.duration, packet.type])
					.toEqual([d, presentation / 25, 0.04, d % 25 === 0 ? 'key' : 'delta']);
				videoHashes.update(createHash('sha256').update(packet.data).digest('hex'));
				expect((await sink.getPacket(presentation / 25, { metadataOnly: true }))!.sequenceNumber).toBe(d);
				const next = await sink.getNextPacket(packet);
				if (d === 29) {
					expect(next).toBeNull();
				} else {
					packet = next!;
				}
			}
			expect(videoHashes.digest('hex')).toBe('96803e93414e059ab86cc311483d9a411fd916cf36a42b3392ee0af215e32db4');
			for (const t of [0.04, 0.12, 0.99, 1, 1.04, 1.19, Infinity]) {
				const key = (await sink.getKeyPacket(t, { verifyKeyPackets: true }))!;
				expect(key.timestamp).toBe(t < 1 ? 0 : 1);
			}
			const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			const audioHashes = createHash('sha256');
			let count = 0;
			for await (const sound of audio.packets()) {
				expect([sound.sequenceNumber, sound.timestamp, sound.duration, sound.byteLength])
					.toEqual([count, count / 25, 0.04, 11520]);
				audioHashes.update(createHash('sha256').update(sound.data).digest('hex'));
				count++;
			}
			expect(count).toBe(30);
			expect(audioHashes.digest('hex')).toBe('1d70e545c22d5a5131854e1f6b2216d59049a28f036e041d4321095542f3398f');
		});

		it('should reject the original FFmpeg B-frame index', async () => {
			const data = await readFile(new URL('../public/mxf-avc420.mxf', import.meta.url));
			// Restore the original video PosTableIndex, temporal offsets and B-reference flags.
			const delta = 424571;
			data[delta] = 0;
			for (let d = 0; d < 30; d++) {
				data[delta + 24 + 15 * d] = 0;
			}
			for (const d of [2, 5, 8, 11, 14, 17, 20, 23, 27]) {
				data[delta + 26 + 15 * d] = 0x33;
			}
			expect(createHash('sha256').update(data).digest('hex'))
				.toBe('75d980434757e72c3062c257d2f6eea3e6fb3b705143d353a3510728119a2d13');
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getPacket(0.04, { metadataOnly: true })).rejects.toThrow(/temporal index/);
		});
	});
});

describe.each([100, 122])('given profile %i AVC with a parameter NAL before a delta picture', (profile) => {
	describe.each(['SPS', 'PPS'] as const)('when only the %s is repeated', (kind) => {
		it.each([false, true])('should enforce stable parameter content when changed is %s', async (changed) => {
			const sps = makeSps(profile === 122 ? 2 : 1, profile === 122 ? 2 : 0, true, profile);
			const repeated = kind === 'SPS' ? sps.slice() : Uint8Array.from(Buffer.from('68ebe2cb22c0', 'hex'));
			if (changed) {
				repeated[kind === 'SPS' ? 3 : 1]! ^= 0x10;
			}
			const fixture = makeIndexedMxf({ avc: true, avcSps: sps, avcDeltaParameters: repeated,
				avcCoding: `060e2b340401010d040102020131${profile === 122 ? '60' : '40'}01` });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				prefetchProfile: 'none', read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			expect((await sink.getPacket(0.12, { metadataOnly: true }))!.type).toBe('delta');
			if (changed) {
				await expect(sink.getPacket(0.12).then(() => 'accepted')).rejects.toThrow(/stable parameter sets/);
			} else {
				const packet = (await sink.getPacket(0.12))!;
				expect([packet.type, packet.timestamp, packet.sequenceNumber]).toEqual(['delta', 0.12, 1]);
				expect(packet.data.subarray(4, 4 + repeated.length)).toEqual(repeated);
			}
		});
	});
});
