import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BufferSource, EncodedPacketSink, Input, MXF, VideoSampleSink } from '../../src/index.js';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import manifest from '../fixtures/mpeg2/open/open422.json' with { type: 'json' };
import regression from '../fixtures/mpeg2/wasm-idct-v1.json' with { type: 'json' };

const integer = (value: number, length: number) => {
	const bytes = Buffer.alloc(length);
	if (length === 8) bytes.writeBigUInt64BE(BigInt(value));
	else bytes.writeUIntBE(value, 0, length);
	return bytes;
};
const hex = (value: string) => Buffer.from(value, 'hex');
const klv = (key: string, value: Uint8Array) => Buffer.concat([
	hex(key), Uint8Array.of(0x83), integer(value.length, 3), value,
]);
const item = (tag: number, value: Uint8Array) => Buffer.concat([integer(tag, 2), integer(value.length, 2), value]);

// Keep the authored backward-only Bs: their pixels depend only on the following I, so the
// qualified WASM regression remains valid despite the lengthened preceding GOP.
const boundaryFixture = (variant: 'complete' | 'partial-index' | 'wrong-anchor' = 'complete') => {
	const original = readFileSync(new URL('../fixtures/mpeg2/open/open422.mxf', import.meta.url));
	const count = 261;
	const header = Buffer.from(original.subarray(0, 6144));
	const duration = hex('020200080000000000000024');
	for (let offset = header.indexOf(duration); offset >= 0; offset = header.indexOf(duration, offset + 12)) {
		header.set(integer(count, 8), offset + 4);
	}
	header.set(integer(1, 4), 24);
	const payload = (ordinal: number) => {
		const packet = manifest.packets[ordinal]!;
		const start = Number(packet.pos) + 20;
		return Buffer.from(original.subarray(start, start + Number(packet.size)));
	};
	const entries: Uint8Array[] = [];
	const pictures: Uint8Array[] = [];
	let streamOffset = 0;
	for (let d = 0; d < count; d++) {
		const withinGop = d % 126;
		const gopStart = d - withinGop;
		const key = withinGop === 0;
		const leading = withinGop === 1 || withinGop === 2;
		const picture = payload(key ? 0 : leading ? withinGop : 3);
		if (key && d !== 0) {
			const gop = picture.indexOf(hex('000001b8'));
			picture[gop + 7] = picture[gop + 7]! & ~0x40;
		}
		if (!key && !leading) {
			const tr = withinGop;
			picture[4] = tr >> 2;
			picture[5] = (picture[5]! & 0x3f) | ((tr & 3) << 6);
		}
		// TemporalOffset is addressed by presentation ordinal; flags and key distances by decode ordinal.
		const temporalOffset = withinGop < 2 ? 1 : withinGop === 2 ? -2 : 0;
		const anchor = leading && gopStart > 0 ? gopStart - 126 : gopStart;
		const distance = variant === 'wrong-anchor' && d === 127 ? -1 : anchor - d;
		entries.push(Buffer.concat([
			Uint8Array.of(temporalOffset & 255, distance & 255,
				key ? (d === 0 ? 0xc0 : 0x40) : leading ? (gopStart === 0 ? 0x13 : 0x33) : 0x22),
			integer(streamOffset, 8),
		]));
		const packet = klv('060e2b34010201010d01030115010500', picture);
		pictures.push(packet);
		streamOffset += packet.length;
	}
	const indexedCount = variant === 'partial-index' ? 255 : count;
	const index = klv('060e2b34025301010d01020101100100', Buffer.concat([
		item(0x3c0a, Buffer.alloc(16)), item(0x3f0b, Buffer.concat([integer(25, 4), integer(1, 4)])),
		item(0x3f0c, integer(0, 8)), item(0x3f0d, integer(indexedCount, 8)), item(0x3f05, integer(0, 4)),
		item(0x3f06, integer(2, 4)), item(0x3f07, integer(1, 4)), item(0x3f08, Uint8Array.of(0)),
		item(0x3f0e, Uint8Array.of(0)),
		item(0x3f09, Buffer.concat([integer(1, 4), integer(6, 4), Uint8Array.of(255), Buffer.alloc(5)])),
		item(0x3f0a, Buffer.concat([integer(indexedCount, 4), integer(11, 4), ...entries.slice(0, indexedCount)])),
	]));
	const bodyOffset = header.length;
	const footerOffset = bodyOffset + 108 + streamOffset;
	header.set(integer(footerOffset, 8), 44);
	const partition = (kind: number, offset: number, previous: number, bodySid: number, indexSize: number) => klv(
		`060e2b34020501010d010201010${kind}0400`, Buffer.concat([
			integer(1, 2), integer(3, 2), integer(1, 4), integer(offset, 8), integer(previous, 8),
			integer(footerOffset, 8), integer(0, 8), integer(indexSize, 8), integer(indexSize ? 2 : 0, 4),
			integer(0, 8), integer(bodySid, 4), hex('060e2b34040101010d01020101010900'),
			integer(0, 4), integer(16, 4),
		]),
	);
	return Buffer.concat([header, partition(3, bodyOffset, 0, 1, 0), ...pictures,
		partition(4, footerOffset, bodyOffset, 0, index.length), index]);
};

describe('given an authored open GOP at the dependency edge of the 256-entry inversion window', () => {
	it('should retain the requested leading B when its preceding anchor is exactly 127 decode ordinals back',
		async () => {
			registerMpeg2Decoder();
			const data = boundaryFixture();
			expect(createHash('sha256').update(data).digest('hex')).toBe(regression.cases.cutoff.inputSha256);
			using input = new Input({ formats: [MXF], source: new BufferSource(data) });
			const track = (await input.getPrimaryVideoTrack())!;
			const packet = (await new EncodedPacketSink(track).getPacket(126 / 25))!;
			expect([packet.sequenceNumber, packet.timestamp, packet.type]).toEqual([127, 126 / 25, 'delta']);
			using sample = (await new VideoSampleSink(track).getSample(126 / 25))!;
			expect([sample.timestamp, sample.duration, sample.format]).toEqual([126 / 25, 1 / 25, 'I422']);
			const pixels = new Uint8Array(sample.allocationSize());
			await sample.copyTo(pixels);
			expect(createHash('sha256').update(pixels).digest('hex'))
				.toBe(regression.cases.cutoff.frames[0]!.sha256);
		},
	);

	it.each([
		['complete', 127, 'dependency anchor is not an indexed I picture'],
		['partial-index', 126, 'missing MPEG-2 temporal index entry'],
		['wrong-anchor', 126, 'unsafe dependency anchor'],
	] as const)('should reject %s before exposing a packet or requested sample', async (variant, pts, error) => {
		registerMpeg2Decoder();
		using input = new Input({ formats: [MXF], source: new BufferSource(boundaryFixture(variant)) });
		const track = (await input.getPrimaryVideoTrack())!;
		const packets = new EncodedPacketSink(track);
		await expect(packets.getPacket(pts / 25)).rejects.toThrow(error);
		await expect(packets.getKeyPacket(pts / 25)).rejects.toThrow(error);
		const sink = new VideoSampleSink(track);
		await expect(sink.getSample(pts / 25)).rejects.toThrow(error);
		const range = sink.samples(pts / 25, (pts + 1) / 25);
		try {
			await expect(range.next()).rejects.toThrow(error);
		} finally {
			await range.return();
		}
	});
});
