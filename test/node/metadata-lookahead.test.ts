import { describe, expect, it } from 'vitest';
import { CustomSource, EncodedPacketSink, Input, MXF, UrlSource } from '../../src/index.js';
import { MetadataLookahead } from '../../examples/media-player/metadata-lookahead.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

const low = { bytes: 16409, frames: 104 };
const standard = { bytes: 65536, frames: 104 };
const high = { bytes: 65536, frames: 72 };

const makeFile = (options: Parameters<typeof makeIndexedMxf>[0] = {}) => makeIndexedMxf({ ...options,
	htj2k: { data: new Uint8Array(1024 * 1024), bits: 16 } });

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 1000; i++) {
		if (condition()) return;
		await new Promise(resolve => setTimeout(resolve, 1));
	}
	throw new Error('Metadata lookup did not settle.');
};

describe('given display-anchored indexed metadata lookahead', () => {
	it('should preserve pending hints on upgrade and expand on downgrade without a display advance', async () => {
		const file = makeFile({ editRate: [24, 1], videoOnly: true });
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
			await metadata.ensure(103 / 24); // Retained useful entries survive the smaller target.
			expect(reads).toHaveLength(102);
			expect(peak).toBe(48);
			expect(errors).toEqual([]);
		} finally {
			release();
			await metadata.dispose();
		}
	});

	it('should preserve a full 104-entry budget on downgrade and release space with display progress', async () => {
		const file = makeFile({ editRate: [24, 1], videoOnly: true });
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
			for (let index = 0; index < 48; index++) await metadata.ensure(index / 24);
			metadata.advance(9 / 24);
			await until(() => prefixes().length === 111);
			for (let index = 9; index <= 80; index++) await metadata.ensure(index / 24);
			expect(prefixes().slice(102).map(([start, end]) => [Math.floor((start - base) / file.stride), end - start]))
				.toEqual(Array.from({ length: 9 }, (_, index) => [104 + index, 16409]));
			await expect(metadata.ensure(113 / 24)).rejects.toThrow('horizon');
			metadata.setPrefixPolicy(high);
			await metadata.ensure(112 / 24);
			expect(prefixes()).toHaveLength(111);
			expect(errors).toEqual([]);
		} finally { await metadata.dispose(); }
	});

	it('should expand equal-byte policies immediately and retain entries when the horizon shrinks', async () => {
		const file = makeFile({ editRate: [24, 1], videoOnly: true });
		using input = new Input({ formats: [MXF], source: new CustomSource({
			getSize: () => file.size, read: file.read }) });
		const errors: unknown[] = [];
		const metadata = new MetadataLookahead((await input.getPrimaryVideoTrack())!, 0,
			error => errors.push(error), high);
		try {
			for (let index = 0; index < 72; index++) await metadata.ensure(index / 24);
			await expect(metadata.ensure(72 / 24)).rejects.toThrow('horizon');
			metadata.setPrefixPolicy(standard);
			await metadata.ensure(103 / 24);
			await expect(metadata.ensure(104 / 24)).rejects.toThrow('horizon');
			const before = file.reads.length;
			metadata.setPrefixPolicy(high);
			await metadata.ensure(103 / 24);
			metadata.advance(32 / 24);
			expect(file.reads.length).toBe(before);
			metadata.advance(33 / 24);
			await metadata.ensure(104 / 24);
			const base = file.offsets[0]! + file.regions[1]!.data.length;
			const prefixes = file.reads.filter(([start, end]) => start >= base + 2 * file.stride
				&& start < base + 200 * file.stride && end - start > 25);
			expect(prefixes.map(([start]) => Math.floor((start - base) / file.stride)))
				.toEqual(Array.from({ length: 103 }, (_, index) => index + 2));
			expect(prefixes.every(([start, end]) => end - start === 65536)).toBe(true);
			expect(errors).toEqual([]);
		} finally { await metadata.dispose(); }
	});

	it('should report a current combined-read failure once and settle the generation', async () => {
		const file = makeFile({ editRate: [24, 1], videoOnly: true });
		const firstHeader = file.offsets[0]! + file.regions[1]!.data.length;
		const failure = new Error('payload read failed');
		using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
			read: (start, end) => {
				if (start >= firstHeader && start < firstHeader + 100 * file.stride && end - start > 25) {
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
		} finally { await metadata.dispose(); }
	});

	it('should reserve only 72 high-tier prefixes and apply changed hints only to new entries', async () => {
		const file = makeFile({ editRate: [24, 1], videoOnly: true });
		const firstHeader = file.offsets[0]! + file.regions[1]!.data.length;
		const warms: { frame: number; bytes: number; display: number }[] = [];
		let display = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		using input = new Input({ formats: [MXF], source: new UrlSource('https://fixture.invalid/warm.mxf', {
			parallelism: 48, rangePolicy: { minimumRequestSize: 32768 },
			fetchFn: async (_url, init) => {
				const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
				const start = Number(match[1]);
				const end = Number(match[2]) + 1;
				if (start >= firstHeader && start < firstHeader + 100 * file.stride && end - start > 25) {
					warms.push({ frame: Math.floor((start - firstHeader) / file.stride), bytes: end - start, display });
					await gate;
				}
				return new Response(file.read(start, end), { status: 206,
					headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` } });
			},
		}) });
		const track = (await input.getPrimaryVideoTrack())!;
		const errors: unknown[] = [];
		const metadata = new MetadataLookahead(track, 0, error => errors.push(error), high);
		try {
			await metadata.ensure(0);
			await until(() => warms.length === 48);
			release();
			await until(() => warms.length === 70);
			await metadata.ensure(71 / 24);
			expect(warms).toHaveLength(70); // Initialization has already cached locations 0 and 1.
			expect(warms.every(warm => warm.frame < 72 && warm.bytes === 65536)).toBe(true);
			expect(warms.reduce((sum, warm) => sum + warm.bytes, 0)).toBeLessThanOrEqual(4718592);
			metadata.setPrefixPolicy(low);
			display = 1;
			metadata.advance(1 / 24);
			await metadata.ensure(72 / 24);
			expect(warms.filter(warm => warm.frame < 73)).toHaveLength(71);
			expect(warms[70]!.frame).toBe(72);
			expect(warms[70]!.bytes).toBe(16409);
			expect(warms.every(warm => warm.frame >= warm.display
				&& warm.frame < warm.display + (warm.bytes === 65536 ? 72 : 104))).toBe(true);
			await metadata.dispose();
			const count = warms.length;
			release();
			await new Promise(resolve => setTimeout(resolve, 10));
			expect(warms.length).toBe(count);
			expect(errors).toEqual([]);
		} finally {
			release();
			await metadata.dispose();
		}
	});

	describe.each([[25, 1], [30, 1], [60, 1], [24000, 1001]] as [number, number][])(
		'when the edit rate is %i/%i rather than 24/1', (numerator, denominator) => {
			it('should reject before fanout, settle disposal, and preserve the borrowed Input', async () => {
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
					const firstHeader = file.offsets[0]! + file.regions[1]!.data.length;
					const futureReads = file.reads.filter(([start]) => start >= firstHeader + 2 * file.stride
						&& start < firstHeader + 100 * file.stride);
					expect(futureReads).toEqual([]);
					const packet = (await new EncodedPacketSink(track).getPacket(3.5 * denominator / numerator,
						{ metadataOnly: true }))!;
					expect(packet.sequenceNumber).toBe(3);
					expect(packet.timestamp).toBeCloseTo(3 * denominator / numerator, 7);
				} finally { await metadata.dispose(); }
			});
		},
	);

	it.each([standard, low, high])('should clamp %j at EOF and preserve the final packet', async (policy) => {
		const file = makeFile({ editRate: [24, 1] });
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
			expect(original.data[39]).toBe(0);
			expect(errors).toEqual([]);
		} finally { await metadata.dispose(); }
	});

	it('should overlap 48 fallback header reads within 72 future frames and await only the needed lookup', async () => {
		const file = makeFile({ editRate: [24, 1] });
		const firstHeader = file.offsets[0]! + file.regions[1]!.data.length;
		const held = new Map<number, () => void>();
		const releasedFrames = new Set<number>();
		const requests: { frame: number; bytes: number; displayIndex: number }[] = [];
		let holding = false;
		let displayIndex = 1;
		let active = 0;
		let peak = 0;
		using input = new Input({ formats: [MXF], source: new UrlSource('https://fixture.invalid/indexed.mxf', {
			parallelism: 48, maxCacheSize: 0, rangePolicy: { minimumRequestSize: 32768 },
			fetchFn: async (_url, init) => {
				const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
				const start = Number(match[1]);
				const end = Number(match[2]) + 1;
				if (holding && end - start === 25 && start >= firstHeader && start < firstHeader + 100 * file.stride) {
					const frame = Math.floor((start - firstHeader) / file.stride);
					requests.push({ frame, bytes: end - start, displayIndex });
					peak = Math.max(peak, ++active);
					if (!releasedFrames.has(frame)) {
						await new Promise<void>((resolve) => {
							held.set(frame, resolve);
						});
					}
					active--;
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
		const metadata = new MetadataLookahead(track, 1 / 24, error => errors.push(error), high);
		try {
			await until(() => held.size === 48);
			expect(peak).toBe(48);
			expect(requests.every(request => request.bytes === 25)).toBe(true);
			// A ready first frame must not wait for the other 48 reads.
			await expect(metadata.ensure(1 / 24)).resolves.toBe(true);
			let nextReady = false;
			const next = metadata.ensure(2 / 24).then(() => {
				nextReady = true;
			});
			expect(nextReady).toBe(false);
			releasedFrames.add(2);
			held.get(2)!();
			await next;
			expect(nextReady).toBe(true);
			displayIndex = 2;
			metadata.advance(2 / 24);
			holding = false;
			for (const release of held.values()) release();
			for (let index = 2; index <= 73; index++) await metadata.ensure(index / 24);
			expect(requests.every(request => request.frame < request.displayIndex + 72)).toBe(true);
			await expect(metadata.ensure(74 / 24)).rejects.toThrow('horizon');
			expect(errors).toEqual([]);
		} finally {
			holding = false;
			for (const release of held.values()) release();
			await metadata.dispose();
		}
	});

	it.each([false, true])('should dispose without canceling a shared reader, combined=%s', async (combined) => {
		const file = makeFile({ editRate: [24, 1], videoOnly: combined });
		const firstHeader = file.offsets[0]! + file.regions[1]!.data.length;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let holding = false;
		const reads: number[] = [];
		using input = new Input({ formats: [MXF], source: new UrlSource('https://fixture.invalid/indexed.mxf', {
			parallelism: 48, maxCacheSize: 0, rangePolicy: { minimumRequestSize: 32768 },
			fetchFn: async (_url, init) => {
				const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
				const start = Number(match[1]);
				const end = Number(match[2]) + 1;
				if (holding && start >= firstHeader && start < firstHeader + 110 * file.stride) {
					reads.push(Math.floor((start - firstHeader) / file.stride));
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
		const metadata = new MetadataLookahead(track, 1 / 24,
			error => errors.push(error), standard);
		try {
			await until(() => reads.length === 48);
			const shared = packets.getPacket(0.125, { metadataOnly: true });
			void shared.catch(() => {});
			metadata.advance(3 / 24);
			metadata.setPrefixPolicy(high);
			metadata.setPrefixPolicy(low);
			await metadata.dispose();
			const atReturn = reads.length;
			release();
			const packet = (await shared)!;
			expect([packet.timestamp, packet.sequenceNumber, packet.isMetadataOnly]).toEqual([0.125, 3, true]);
			await new Promise(resolve => setTimeout(resolve, 10));
			expect(reads.slice(atReturn).every(frame => frame === 3)).toBe(true);
			const later = await packets.getPacket(5 / 24, { metadataOnly: true });
			expect(later?.timestamp).toBeCloseTo(5 / 24, 7);
			expect(errors).toEqual([]);
		} finally {
			release();
			await metadata.dispose();
		}
	});
});
