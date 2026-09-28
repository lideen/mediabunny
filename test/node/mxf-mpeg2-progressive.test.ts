import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BufferSource, CustomSource, EncodedPacketSink, Input, MXF, VideoSampleSink } from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import padded from '../fixtures/mpeg2/progressive/padded-high.json' with { type: 'json' };
import high1440 from '../fixtures/mpeg2/progressive/high1440.json' with { type: 'json' };
import closed from '../fixtures/mpeg2/packets.json' with { type: 'json' };
import regression from '../fixtures/mpeg2/wasm-idct-v1.json' with { type: 'json' };

const fixture = (name: string) => new Uint8Array(readFileSync(
	new URL(`../fixtures/mpeg2/${name}.mxf`, import.meta.url),
));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const bHeader = () => {
	const offset = Number(closed.packets.filter(p => p.codec_type === 'video')[2]!.pos) + 20;
	return fixture('main420').slice(offset, offset + 64);
};
const replace = (data: Uint8Array, before: string, after: string) => {
	const offset = Buffer.from(data).indexOf(Buffer.from(before, 'hex'));
	if (offset < 0) throw new Error('Missing fixture property');
	data.set(Buffer.from(after, 'hex'), offset);
};

// Repackage authored I/P payloads into a single long GOP. Only temporal references change;
// this fixture exercises packet/header validation, not the pixels of repeated P pictures.
const longGopFixture = (ending: 'track-end' | 'next-key' | 'non-boundary' | 'hidden-b') => {
	const integer = (value: number, length: number) => {
		const bytes = Buffer.alloc(length);
		bytes.writeUIntBE(value, 0, length);
		return bytes;
	};
	const uint64 = (value: number) => {
		const bytes = Buffer.alloc(8);
		bytes.writeBigUInt64BE(BigInt(value));
		return bytes;
	};
	const hex = (value: string) => Buffer.from(value, 'hex');
	const klv = (key: string, value: Uint8Array) => Buffer.concat([
		hex(key), Uint8Array.of(0x83), integer(value.length, 3), value,
	]);
	const item = (tag: number, value: Uint8Array) => Buffer.concat([integer(tag, 2), integer(value.length, 2), value]);
	const count = ending === 'track-end' ? 128 : ending === 'hidden-b' ? 130 : 129;
	const original = fixture('progressive/high1440');
	const header = Buffer.from(original.slice(0, 6144));
	const duration = hex('020200080000000000000024');
	for (let offset = header.indexOf(duration); offset >= 0; offset = header.indexOf(duration, offset + 12)) {
		header.set(uint64(count), offset + 4);
	}
	header.set(integer(1, 4), 24); // KAG=1: synthetic partitions need no alignment fill.
	const video = high1440.packets.filter(p => p.codec_type === 'video');
	const payload = (ordinal: number) => {
		const packet = video[ordinal]!;
		const start = Number(packet.pos) + 20;
		return original.slice(start, start + Number(packet.size));
	};
	const entries: Uint8Array[] = [];
	const pictures: Uint8Array[] = [];
	let streamOffset = 0;
	for (let i = 0; i < count; i++) {
		const key = i === 0 || (i === 128 && ending === 'next-key');
		const picture = payload(key ? 0 : 1);
		if (i === 129 && ending === 'hidden-b') picture.set(bHeader());
		if (!key) {
			picture[4] = i >> 2;
			picture[5] = (picture[5]! & 0x3f) | ((i & 3) << 6);
		}
		entries.push(Buffer.concat([Uint8Array.of(0, key ? 0 : -i & 255, key ? 0xc0 : 0x22),
			uint64(streamOffset)]));
		const packet = klv('060e2b34010201010d01030115010500', picture);
		pictures.push(packet);
		streamOffset += packet.length;
	}
	const index = klv('060e2b34025301010d01020101100100', Buffer.concat([
		item(0x3c0a, Buffer.alloc(16)), item(0x3f0b, Buffer.concat([integer(24, 4), integer(1, 4)])),
		item(0x3f0c, uint64(0)), item(0x3f0d, uint64(count)), item(0x3f05, integer(0, 4)),
		item(0x3f06, integer(2, 4)), item(0x3f07, integer(1, 4)), item(0x3f08, Uint8Array.of(0)),
		item(0x3f0e, Uint8Array.of(0)),
		item(0x3f09, Buffer.concat([integer(1, 4), integer(6, 4), Buffer.alloc(6)])),
		item(0x3f0a, Buffer.concat([integer(count, 4), integer(11, 4), ...entries])),
	]));
	const bodyOffset = header.length;
	const footerOffset = bodyOffset + 108 + streamOffset;
	header.set(uint64(footerOffset), 44);
	const partition = (kind: number, offset: number, previous: number, bodySid: number, indexSize: number) => klv(
		`060e2b34020501010d010201010${kind}0400`, Buffer.concat([
			integer(1, 2), integer(3, 2), integer(1, 4), uint64(offset), uint64(previous), uint64(footerOffset),
			uint64(0), uint64(indexSize), integer(indexSize ? 2 : 0, 4), uint64(0), integer(bodySid, 4),
			hex('060e2b34040101010d01020101010900'), integer(0, 4), integer(16, 4),
		]),
	);
	const data = Buffer.concat([header, partition(3, bodyOffset, 0, 1, 0), ...pictures,
		partition(4, footerOffset, bodyOffset, 0, index.length), index]);
	return { data, firstPicture: payload(0) };
};

describe('given progressive MPEG-2 with open-flag I/P GOPs', () => {
	describe('when a restart reaches the 128-picture interval limit', () => {
		it.each(['track-end', 'next-key'] as const)(
			'should expose a complete 128-picture interval terminated by %s', async (ending) => {
				const { data, firstPicture } = longGopFixture(ending);
				using input = new Input({ formats: [MXF], source: new BufferSource(data) });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				const key = (await sink.getFirstPacket())!;
				expect([key.type, key.timestamp, key.duration]).toEqual(['key', 0, 1 / 24]);
				expect(hash(key.data)).toBe(hash(firstPicture));
				const last = (await sink.getPacket(127 / 24))!;
				expect([last.type, last.timestamp]).toEqual(['delta', 127 / 24]);
				const next = await sink.getNextPacket(last);
				if (ending === 'track-end') expect(next).toBeNull();
				else expect([next!.type, next!.timestamp]).toEqual(['key', 128 / 24]);
			},
		);

		it.each(['non-boundary', 'hidden-b'] as const)(
			'should reject %s before exposing a key when the 129th entry is not a boundary', async (ending) => {
				const { data } = longGopFixture(ending);
				using input = new Input({ formats: [MXF], source: new BufferSource(data) });
				const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
				await expect(sink.getFirstPacket({ metadataOnly: true })).rejects.toThrow(/bounded unreordered I\/P/);
			},
		);
	});

	describe('when seeking padded High and High-1440 pictures', () => {
		it.each([['padded-high', padded], ['high1440', high1440]] as const)(
			'should decode %s visible planes and preserve packet/audio timing at consecutive I and final GOPs',
			async (name, manifest) => {
				registerMpeg2Decoder();
				const data = fixture(`progressive/${name}`);
				expect(hash(data)).toBe(regression.cases[name].inputSha256);
				let bytes = 0;
				using input = new Input({ formats: [MXF], source: new CustomSource({
					getSize: () => data.length, prefetchProfile: 'none',
					read: (start, end) => {
						bytes += end - start;
						if (bytes > 16 * 1024 * 1024) throw new Error('read budget exceeded');
						return data.slice(start, end);
					},
				}) });
				const track = (await input.getPrimaryVideoTrack())!;
				expect(await track.getDecoderConfig()).toMatchObject({ codedWidth: manifest.width, codedHeight: 720 });
				const sink = new EncodedPacketSink(track);
				const samples = new VideoSampleSink(track);
				for (const ordinal of [35, 0, 12, 13, 14, 25]) {
					using sample = (await samples.getSample(ordinal / 24))!;
					expect([sample.timestamp, sample.duration, sample.codedWidth, sample.codedHeight])
						.toEqual([ordinal / 24, 1 / 24, manifest.width, 720]);
					const pixels = new Uint8Array(sample.allocationSize());
					await sample.copyTo(pixels);
					expect(hash(pixels)).toBe(regression.cases[name].frames[ordinal]!.sha256);
					const packet = (await sink.getPacket(ordinal / 24))!;
					const expected = manifest.packets.filter(p => p.codec_type === 'video')[ordinal]!;
					expect(`SHA256:${hash(packet.data)}`).toBe(expected.data_hash);
				}
				const openKey = (await sink.getKeyPacket(13 / 24))!;
				expect(openKey.type).toBe('key');
				expect(await track.determinePacketType(openKey)).toBeNull();
				const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
				for (const ordinal of [0, 18, 35]) {
					const packet = (await audio.getPacket(ordinal / 24))!;
					expect([packet.timestamp, packet.duration]).toEqual([ordinal / 24, 1 / 24]);
					expect(`SHA256:${hash(packet.data)}`)
						.toBe(manifest.packets.filter(p => p.codec_type === 'audio')[ordinal]!.data_hash);
				}
			},
		);
	});

	describe('when the requested restart cannot prove an I/P-only interval', () => {
		it('should prove each requested GOP rather than trust a previous safe interval', async () => {
			const data = fixture('progressive/high1440');
			const later = high1440.packets.filter(p => p.codec_type === 'video')[18]!;
			const offset = Number(later.pos) + 20;
			data.set(bHeader(), offset);
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			expect((await sink.getFirstPacket())!.type).toBe('key');
			await expect(sink.getKeyPacket(15 / 24, { metadataOnly: true }))
				.rejects.toThrow(/index picture flags disagree/);
		});

		it('should reject B pictures in an open-declared track before returning its first key', async () => {
			const data = fixture('main420');
			replace(data, '8004000101', '8004000100');
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			await expect(new EncodedPacketSink(track).getFirstPacket()).rejects.toThrow(/I\/P/);
		});

		it('should reject a hidden B-picture header even when its index claims P', async () => {
			const data = fixture('progressive/high1440');
			const third = high1440.packets.filter(p => p.codec_type === 'video')[3]!;
			const offset = Number(third.pos) + 20;
			data.set(bHeader(), offset);
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			await expect(new EncodedPacketSink(track).getFirstPacket()).rejects.toThrow(/index picture flags disagree/);
		});
	});

	describe('when a descriptor claims cropping rather than macroblock padding', () => {
		it.each([
			['32030004000006c0', '32030004000006d0'],
			['3206000400000000', '3206000400000001'],
			['320a000400000000', '320a000400000001'],
			['32050004000006b6', '32050004000006b4'],
		] as const)('should reject the unsupported rectangle %s', async (before, after) => {
			const data = fixture('progressive/padded-high');
			replace(data, before, after);
			using input = new Input({ source: new BufferSource(data), formats: [MXF] });
			await expect(input.getPrimaryVideoTrack()).rejects.toThrow(/padding|rectangle|cropped/);
		});
	});

	describe('when canceled during a future picture-header proof', () => {
		it('should stop the proof and allow a later uncanceled restart', async () => {
			const data = fixture('progressive/high1440');
			const target = Number(high1440.packets.filter(p => p.codec_type === 'video')[3]!.pos) + 20;
			let entered!: () => void;
			let release!: () => void;
			const blocked = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let pause = true;
			let reads = 0;
			let futureHeaderReads = 0;
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => data.length, prefetchProfile: 'none', maxCacheSize: 0,
				read: async (start, end) => {
					reads++;
					if (start <= target && end > target) futureHeaderReads++;
					if (pause && start <= target && end > target) {
						pause = false;
						entered();
						await gate;
					}
					return data.slice(start, end);
				},
			}) });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const controller = new AbortController();
			const pending = sink.getFirstPacket({ metadataOnly: true, signal: controller.signal });
			const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
			await blocked;
			const before = reads;
			controller.abort();
			release();
			await rejected;
			expect(reads).toBe(before);
			const packet = (await sink.getFirstPacket())!;
			expect([packet.type, packet.timestamp]).toEqual(['key', 0]);
			expect(`SHA256:${hash(packet.data)}`).toBe(high1440.packets[0]!.data_hash);
			const proven = futureHeaderReads;
			await sink.getFirstPacket({ metadataOnly: true });
			expect(futureHeaderReads).toBe(proven);
		});
	});
});
