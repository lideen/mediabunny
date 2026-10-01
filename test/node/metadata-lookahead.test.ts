import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { CustomSource, EncodedPacketSink, Input, MXF, UrlSource } from '../../src/index.js';
import { MetadataLookahead } from '../../examples/media-player/metadata-lookahead.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

const low = { bytes: 16409, frames: 104 };
const standard = { bytes: 65536, frames: 104 };
const high = { bytes: 65536, frames: 72 };
const makeFile = (options: Parameters<typeof makeIndexedMxf>[0] = {}) => makeIndexedMxf({
	editRate: [24, 1], videoOnly: true, ...options,
	htj2k: { data: new Uint8Array(1024 * 1024), bits: 16, width: 960, height: 540 },
});
const until = async (condition: () => boolean) => {
	for (let i = 0; i < 1000; i++) {
		if (condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 1));
	}
	throw new Error('Metadata lookup did not settle.');
};

describe('given display-anchored indexed metadata lookahead', () => {
	describe('when changing prefix policy without displaying a frame', () => {
		it('should preserve pending reservations and apply new policy only to newly admitted reads', async () => {
			const file = makeFile();
			const base = file.offsets[0]! + file.regions[1]!.data.length;
			const reads: { frame: number; bytes: number }[] = [];
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let active = 0;
			let peak = 0;
			using input = new Input({ formats: [MXF], source: new UrlSource('https://fixture.invalid/policy.mxf', {
				parallelism: 48, rangePolicy: { minimumRequestSize: 32768 },
				fetchFn: async (_url, init) => {
					const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
					const start = Number(match[1]);
					const end = Number(match[2]) + 1;
					if (start >= base && start < base + 200 * file.stride && end - start > 25) {
						reads.push({ frame: Math.floor((start - base) / file.stride), bytes: end - start });
						peak = Math.max(peak, ++active);
						await gate;
						active--;
					}
					return new Response(file.read(start, end), { status: 206,
						headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` } });
				},
			}) });
			const errors: unknown[] = [];
			const metadata = new MetadataLookahead((await input.getPrimaryVideoTrack())!, 0,
				error => errors.push(error), low);
			try {
				await until(() => reads.length === 48);
				metadata.setPrefixPolicy(high);
				expect(reads.every(read => read.bytes === 16409)).toBe(true);
				release();
				await until(() => reads.length === 70);
				await metadata.ensure(71 / 24);
				expect(reads.slice(48).every(read => read.bytes === 65536)).toBe(true);
				metadata.setPrefixPolicy(low);
				await until(() => reads.length === 102);
				await metadata.ensure(103 / 24);
				expect(reads.slice(70).every(read => read.bytes === 16409)).toBe(true);
				expect(new Set(reads.map(read => read.frame)).size).toBe(reads.length);
				expect(reads.reduce((sum, read) => sum + read.bytes, 2 * 16409)).toBeLessThanOrEqual(4718592);
				metadata.setPrefixPolicy(high);
				await metadata.ensure(103 / 24);
				expect(reads).toHaveLength(102);
				expect(peak).toBe(48);
				expect(errors).toEqual([]);
			} finally {
				release();
				await metadata.dispose();
			}
		});

		it('should retain the full 6.5 MiB reservation on downgrade until display releases entries', async () => {
			const file = makeFile();
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => file.size, read: file.read }) });
			const errors: unknown[] = [];
			const metadata = new MetadataLookahead((await input.getPrimaryVideoTrack())!, 0,
				error => errors.push(error), standard);
			try {
				const base = file.offsets[0]! + file.regions[1]!.data.length;
				const prefixes = () => file.reads.filter(([start, end]) => start >= base + 2 * file.stride
					&& start < base + 200 * file.stride && end - start > 25);
				await until(() => prefixes().length === 102);
				await metadata.ensure(103 / 24);
				metadata.setPrefixPolicy(low);
				expect(prefixes()).toHaveLength(102);
				for (let index = 0; index < 48; index++) {
					await metadata.ensure(index / 24);
				}
				metadata.advance(9 / 24);
				await until(() => prefixes().length === 111);
				await metadata.ensure(112 / 24);
				const newPrefixes = prefixes().slice(102)
					.map(([start, end]) => [Math.floor((start - base) / file.stride), end - start]);
				expect(newPrefixes)
					.toEqual(Array.from({ length: 9 }, (_, index) => [104 + index, 16409]));
				await expect(metadata.ensure(113 / 24)).rejects.toThrow('horizon');
				metadata.setPrefixPolicy(high);
				await metadata.ensure(112 / 24);
				expect(prefixes()).toHaveLength(111);
				expect(errors).toEqual([]);
			} finally {
				await metadata.dispose();
			}
		});
	});

	describe.each([[25, 1], [30, 1], [60, 1], [24000, 1001]] as [number, number][])(
		'when the edit rate is %i/%i rather than 24/1', (numerator, denominator) => {
			it('should reject before fanout and preserve the borrowed Input', async () => {
				const file = makeFile({ editRate: [numerator, denominator] });
				using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
					read: file.read, maxCacheSize: 0 }) });
				const track = (await input.getPrimaryVideoTrack())!;
				const errors: unknown[] = [];
				const metadata = new MetadataLookahead(track, 0, error => errors.push(error), standard);
				try {
					await expect(metadata.ensure(0)).rejects.toThrow('24 fps');
					await metadata.dispose();
					expect(errors).toHaveLength(1);
					const base = file.offsets[0]! + file.regions[1]!.data.length;
					expect(file.reads.filter(([start]) => start >= base + 2 * file.stride
						&& start < base + 100 * file.stride)).toEqual([]);
					expect((await new EncodedPacketSink(track).getPacket(3.5 * denominator / numerator,
						{ metadataOnly: true }))!.sequenceNumber).toBe(3);
				} finally {
					await metadata.dispose();
				}
			});
		},
	);

	describe('when a generation ends', () => {
		it('should report a current prefix-read failure once and settle the generation', async () => {
			const file = makeFile();
			const base = file.offsets[0]! + file.regions[1]!.data.length;
			const failure = new Error('payload read failed');
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: (start, end) => {
					if (start >= base && start < base + 100 * file.stride && end - start > 25) {
						throw failure;
					}
					return file.read(start, end);
				} }) });
			const errors: unknown[] = [];
			const metadata = new MetadataLookahead((await input.getPrimaryVideoTrack())!, 0,
				error => errors.push(error), standard);
			void metadata.ensure(0).catch(() => {});
			try {
				await until(() => errors.length > 0);
				await metadata.dispose();
				await expect(metadata.ensure(0)).rejects.toBe(failure);
				expect(errors).toEqual([failure]);
			} finally {
				await metadata.dispose();
			}
		});

		it.each([standard, low, high])('should clamp %j at EOF and preserve the last packet', async (policy) => {
			const file = makeFile();
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: file.read }) });
			const track = (await input.getPrimaryVideoTrack())!;
			const errors: unknown[] = [];
			const metadata = new MetadataLookahead(track, (file.count - 2) / 24, error => errors.push(error), policy);
			try {
				await expect(metadata.ensure((file.count - 2) / 24)).resolves.toBe(true);
				await expect(metadata.ensure((file.count - 1) / 24)).resolves.toBe(true);
				const before = file.reads.length;
				await expect(metadata.ensure(file.count / 24)).resolves.toBe(false);
				expect(file.reads.length).toBe(before);
				const original = (await new EncodedPacketSink(track).getPacket((file.count - 1) / 24))!;
				expect([original.timestamp, original.sequenceNumber, original.isMetadataOnly, original.data.length])
					.toEqual([(file.count - 1) / 24, file.count - 1, false, file.frameSize]);
				expect(errors).toEqual([]);
			} finally {
				await metadata.dispose();
			}
		});

		it.each([false, true])('should cancel without poisoning a shared reader, prefix=%s', async (prefix) => {
			const file = makeFile({ videoOnly: prefix });
			const base = file.offsets[0]! + file.regions[1]!.data.length;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let holding = false;
			const reads: number[] = [];
			using input = new Input({ formats: [MXF], source: new UrlSource('https://fixture.invalid/cancel.mxf', {
				parallelism: 48, maxCacheSize: 0, rangePolicy: { minimumRequestSize: 32768 },
				fetchFn: async (_url, init) => {
					const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
					const start = Number(match[1]);
					const end = Number(match[2]) + 1;
					if (holding && start >= base && start < base + 110 * file.stride) {
						reads.push(Math.floor((start - base) / file.stride));
						await gate;
					}
					return new Response(file.read(start, end), { status: 206,
						headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` } });
				},
			}) });
			const track = (await input.getPrimaryVideoTrack())!;
			const packets = new EncodedPacketSink(track);
			await packets.getPacket(0, { metadataOnly: true });
			await packets.getPacket(1 / 24, { metadataOnly: true });
			holding = true;
			const errors: unknown[] = [];
			const metadata = new MetadataLookahead(track, 1 / 24, error => errors.push(error), standard);
			try {
				await until(() => reads.length === 48);
				const shared = packets.getPacket(0.125, { metadataOnly: true });
				void shared.catch(() => {});
				metadata.advance(3 / 24);
				metadata.setPrefixPolicy(high);
				metadata.setPrefixPolicy(low);
				const disposed = metadata.dispose();
				expect(await Promise.race([disposed.then(() => 'disposed'), setImmediate('still reading')]))
					.toBe('disposed');
				const atReturn = reads.length;
				release();
				const packet = (await shared)!;
				expect([packet.timestamp, packet.sequenceNumber, packet.isMetadataOnly]).toEqual([0.125, 3, true]);
				await new Promise(resolve => setTimeout(resolve, 10));
				expect(reads.slice(atReturn).every(frame => frame === 3)).toBe(true);
				expect((await packets.getPacket(5 / 24, { metadataOnly: true }))?.timestamp).toBeCloseTo(5 / 24, 7);
				expect(errors).toEqual([]);
			} finally {
				release();
				await metadata.dispose();
			}
		});
	});
});
