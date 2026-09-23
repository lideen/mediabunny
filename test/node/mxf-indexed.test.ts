import { describe, expect, it } from 'vitest';
import { Input, InputDisposedError } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { makeMxf } from './mxf-fixture.js';
import { MXF } from '../../src/input-format.js';
import { CustomSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const indexField = (fixture: ReturnType<typeof makeIndexedMxf>, tag: number, segment = 0) => {
	const data = fixture.regions.at(-1)!.data;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 108;
	for (let i = 0; i < segment; i++) {
		offset += 20 + data[offset + 17]! * 65536 + data[offset + 18]! * 256 + data[offset + 19]!;
	}
	offset += 20;
	while (offset < data.length) {
		const length = view.getUint16(offset + 2);
		if (view.getUint16(offset) === tag) return data.subarray(offset + 4, offset + 4 + length);
		offset += 4 + length;
	}
	throw new Error('Fixture index property not found');
};

describe('given a ten GB logical multi-partition MXF', () => {
	describe('when seeking cold near the end through a no-prefetch source', () => {
		const cases = [{ cbe: false }, { cbe: true }, { ber: true }, { ber: true, noRip: true }];
		it.each(cases)('should read bounded bytes using index options %j', async (options) => {
			const fixture = makeIndexedMxf(options);
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const packet = await sink.getPacket(390, { metadataOnly: true });
			expect([packet!.timestamp, packet!.duration, packet!.sequenceNumber, packet!.byteLength])
				.toEqual([390, 0.04, 9750, 1048576]);
			const bytes = fixture.reads.reduce((sum, [start, end]) => sum + end - start, 0);
			console.log('MXF cold late metadata', { options, bytes, reads: fixture.reads.length });
			expect(bytes).toBeLessThan(200000);
			// Apart from each partition's first system KLV, no earlier content package is needed.
			for (const [start, end] of fixture.reads) {
				for (let p = 0; p < fixture.offsets.length; p++) {
					const low = fixture.offsets[p]! + 108 + 32;
					const high = fixture.offsets[p + 1] ?? fixture.footerOffset;
					if (start >= low && start < high) {
						expect(start).toBeGreaterThanOrEqual(fixture.offsets[2]! + 108 + 1750 * fixture.stride);
						expect(end).toBeLessThanOrEqual(fixture.offsets[2]! + 108 + 1750 * fixture.stride + 32 + 20);
					}
				}
			}
			const next = await sink.getNextPacket(packet!);
			expect(next!.data[39]).toBe(23);
			expect(next!.timestamp).toBe(390.04);
			const last = (await sink.getPacket(Infinity, { metadataOnly: true }))!;
			expect(last.sequenceNumber).toBe(9999);
			const beforeNext = fixture.reads.length;
			expect(await sink.getNextPacket(last, { metadataOnly: true })).toBeNull();
			expect(fixture.reads.length).toBe(beforeNext);
			const audio = new EncodedPacketSink((await input.getAudioTracks())[1]!);
			const sound = await audio.getPacket(390, { metadataOnly: true });
			expect([sound!.timestamp, sound!.duration, sound!.byteLength]).toEqual([390, 0.04, 5760]);
			await expect(audio.getNextPacket(last, { metadataOnly: true })).rejects.toThrow(/does not belong/);
			const concurrent = await Promise.all([
				sink.getPacket(1, { metadataOnly: true }), audio.getPacket(1, { metadataOnly: true }),
			]);
			expect(concurrent.map(packet => [packet!.timestamp, packet!.sequenceNumber])).toEqual([[1, 25], [1, 25]]);
		});
	});

	describe('when the first packet is requested without scanning the file or its index entries', () => {
		it('should return identical concurrent packet identity and leave later essence unread', async () => {
			const fixture = makeIndexedMxf({ ber: true });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const [first, duplicate] = await Promise.all([
				sink.getFirstPacket({ metadataOnly: true }), sink.getFirstPacket({ metadataOnly: true }),
			]);
			expect([first!.sequenceNumber, first!.timestamp, first!.duration, first!.byteLength])
				.toEqual([0, 0, 0.04, 1048576]);
			expect(duplicate).toEqual(first);
			const bytes = fixture.reads.reduce((sum, [a, b]) => sum + b - a, 0);
			console.log('MXF cold first metadata', { bytes, reads: fixture.reads.length });
			expect(bytes).toBeLessThan(16000);
			expect(fixture.reads.length).toBeLessThan(25);
			expect((await sink.getNextPacket(first!, { metadataOnly: true }))!.sequenceNumber).toBe(1);
		});
	});

	describe('when an index or partition directory is corrupt', () => {
		it.each([
			['delta slice', (f: ReturnType<typeof makeIndexedMxf>) => { indexField(f, 0x3f09)[9] = 2; }],
			['position table reference', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f09)[8] = 1;
			}],
			['index duration', (f: ReturnType<typeof makeIndexedMxf>) => { indexField(f, 0x3f0d)[7] = 0xff; }],
			['entry array length', (f: ReturnType<typeof makeIndexedMxf>) => { indexField(f, 0x3f0a)[7] = 14; }],
			['overlapping or unordered index segments', (f: ReturnType<typeof makeIndexedMxf>) => {
				const field = indexField(f, 0x3f0c, 1);
				new DataView(field.buffer, field.byteOffset).setBigUint64(0, 1999n);
			}],
			['nonmonotonic index stream offsets', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f0a).fill(0, 26, 34);
			}],
			['index delta exceeds edit unit', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f09).fill(0xff, 16, 20);
			}],
			['integer exceeds safe range', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f0a).fill(0xff, 11, 19);
			}],
			['does not point to a KLV', (f: ReturnType<typeof makeIndexedMxf>) => {
				indexField(f, 0x3f0a)[18] = 100;
			}],
			['disagrees with partition', (f: ReturnType<typeof makeIndexedMxf>) => {
				const data = f.regions.at(-1)!.data;
				const length = new DataView(data.buffer).getUint32(data.length - 4);
				data[data.length - length + 20 + 12 + 3] = 9;
			}],
			['disagrees with partition', (f: ReturnType<typeof makeIndexedMxf>) => {
				f.regions[2]!.data[20 + 16 + 7]!++;
			}],
		] as const)('should reject %s rather than return a packet with invented timing', async (error, corrupt) => {
			const fixture = makeIndexedMxf();
			corrupt(fixture);
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getFirstPacket({ metadataOnly: true })).rejects.toThrow(error);
		});
	});

	describe('when indexes are repeated or container Fill spans partitions', () => {
		const cases = [{ repeatIndex: true }, { padding: true }];
		it.each(cases)('should preserve stream offsets with %j', async (options) => {
			const fixture = makeIndexedMxf(options);
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const packet = await sink.getPacket(390);
			expect([packet!.timestamp, packet!.sequenceNumber, packet!.data[39]]).toEqual([390, 9750, 22]);
			const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			expect((await audio.getPacket(390, { metadataOnly: true }))!.timestamp).toBe(390);
		});

		it('should reject conflicting repeated entries instead of choosing the last copy', async () => {
			const fixture = makeIndexedMxf({ repeatIndex: true });
			const field = indexField(fixture, 0x3f0a);
			const view = new DataView(field.buffer, field.byteOffset);
			view.setBigUint64(11, BigInt(fixture.stride));
			view.setBigUint64(26, BigInt(fixture.stride * 2));
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await expect(sink.getFirstPacket({ metadataOnly: true })).rejects.toThrow(/conflicting repeated/);
		});
	});

	describe('when a CBE stream has a larger first edit unit', () => {
		it('should fall back to scanning rather than multiplying the later unit size from byte zero', async () => {
			const fixture = makeIndexedMxf({ cbe: true, exceptionalCbe: true });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const packet = await sink.getPacket(0.04);
			expect([packet!.timestamp, packet!.sequenceNumber, packet!.data[39]]).toEqual([0.04, 1, 1]);
		});
	});

	describe('when metadata and an index omit trailing essence', () => {
		it('should trust the indexed duration without claiming a complete essence-count validation', async () => {
			const fixture = makeIndexedMxf({ ber: true, extraEssence: true });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const last = (await sink.getPacket(Infinity, { metadataOnly: true }))!;
			expect(last.sequenceNumber).toBe(9998);
			const reads = fixture.reads.length;
			expect(await sink.getNextPacket(last, { metadataOnly: true })).toBeNull();
			expect(fixture.reads.length).toBe(reads);
		});
	});

	describe('when the index edit rate cannot be used for this track', () => {
		it('should fall back to exact sequential packet discovery', async () => {
			const fixture = makeIndexedMxf();
			indexField(fixture, 0x3f0b)[3] = 24;
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const first = await sink.getFirstPacket({ metadataOnly: true });
			const next = await sink.getNextPacket(first!, { metadataOnly: true });
			expect([next!.sequenceNumber, next!.timestamp, next!.byteLength]).toEqual([1, 0.04, 1048576]);
		});
	});

	describe('when PCM is not locked to picture', () => {
		it('should count actual samples instead of assigning the indexed picture timestamp', async () => {
			const fixture = makeIndexedMxf({ unlockedAudio: true });
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: fixture.read }), formats: [MXF] });
			const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			const packet = await audio.getPacket(0.04, { metadataOnly: true });
			expect([packet!.timestamp, packet!.duration, packet!.sequenceNumber])
				.toEqual([1910 / 48000, 0.04, 1]);
		});
	});

	describe('when disposed during index discovery', () => {
		it('should reject the pending seek without returning an indexed packet', async () => {
			const fixture = makeIndexedMxf({ ber: true });
			let notifyRead!: () => void;
			let releaseRead!: () => void;
			const started = new Promise<void>((resolve) => {
				notifyRead = resolve;
			});
			const released = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
			using input = new Input({ source: new CustomSource({ getSize: () => fixture.size,
				read: async (start, end) => {
					if (start >= fixture.footerOffset) {
						notifyRead();
						await released;
					}
					return fixture.read(start, end);
				} }), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const pending = expect(sink.getPacket(390, { metadataOnly: true }))
				.rejects.toBeInstanceOf(InputDisposedError);
			await started;
			input.dispose();
			releaseRead();
			await pending;
		});

		it.each([false, true])('should reject a warmed read after disposal, indexed=%s', async (indexed) => {
			const fixture = makeIndexedMxf({ ber: true });
			using input = new Input({ source: indexed
				? new CustomSource({ getSize: () => fixture.size, read: fixture.read })
				: new BufferSource(makeMxf().data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await sink.getFirstPacket({ metadataOnly: true });
			const pending = sink.getFirstPacket({ metadataOnly: true });
			input.dispose();
			await expect(pending).rejects.toBeInstanceOf(InputDisposedError);
		});
	});
});

describe('given the independently probed generated 24-second ProRes LT and stereo PCM fixture', () => {
	describe('when seeking across distributed index and body partitions', () => {
		const path = process.env['MXF_GENERATED_FIXTURE'];
		it.skipIf(!path)('should match ffprobe packet hashes and exact clocks', async () => {
			const file = await open(path!, 'r');
			try {
				const size = (await file.stat()).size;
				const reads: [number, number][] = [];
				using input = new Input({ source: new CustomSource({ getSize: () => size,
					read: async (start, end) => {
						reads.push([start, end]);
						const data = new Uint8Array(end - start);
						await file.read(data, 0, data.length, start);
						return data;
					} }), formats: [MXF] });
				const video = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
				const last = await video.getPacket(Infinity, { metadataOnly: true });
				expect([last!.sequenceNumber, last!.timestamp, last!.byteLength]).toEqual([599, 23.96, 122576]);
				console.log('MXF generated cold last metadata', {
					bytes: reads.reduce((sum, [a, b]) => sum + b - a, 0), reads: reads.length,
				});
				expect(reads.reduce((sum, [a, b]) => sum + b - a, 0)).toBeLessThan(30000);
				for (const [index, expected] of [
					[599, '0bd58c6f840ea1ed6083bf352bc17210bb3476e724845b9589a87705632d5d4c'],
					[0, 'd879dd35ddf8cc272059249e3a7502855bfa9f46a1fc3a4cc9b4aa6d85de000b'],
					[250, '99030f9919cacb2ec8fa28b43ba3fc7e92f4e1c60b90bd45481a16ee7c647c3c'],
					[251, 'ffff77f098b8b6c2988108cb08b96b551f1320c6f261c1e8290fd5ea308a1fac'],
					[501, 'ba79649d303f2f335ce8898ea6a31725615d0ed514969c8dfbb5496ee6af4d8a'],
					[502, 'e013ae0897a0e7c6e098c97f911f6f977bc088898fe5a1cc807d320dbc688550'],
				] as const) {
					const packet = await video.getPacket(index / 25);
					expect(createHash('sha256').update(packet!.data).digest('hex')).toBe(expected);
					expect([packet!.timestamp, packet!.duration, packet!.sequenceNumber])
						.toEqual([index / 25, 0.04, index]);
					if (index === 250 || index === 501) {
						const next = await video.getNextPacket(packet!, { metadataOnly: true });
						expect([next!.timestamp, next!.sequenceNumber]).toEqual([(index + 1) / 25, index + 1]);
					}
				}
				const sound = await audio.getPacket(23.96);
				expect(createHash('sha256').update(sound!.data).digest('hex'))
					.toBe('67078cf6805bbd9cd68e7dcb4aaddff5028b4e2fe2d328470ef57ca397629e92');
				expect([sound!.timestamp, sound!.duration, sound!.byteLength]).toEqual([23.96, 0.04, 11520]);
				expect(await video.getNextPacket(last!)).toBeNull();
			} finally {
				await file.close();
			}
		});
	});
});
