import { makeMxf } from './mxf-fixture.js';

const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const join = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
const integer = (value: number, length: number) => {
	const result = new Uint8Array(length);
	for (let i = length - 1; i >= 0; i--) {
		result[i] = value & 255;
		value = Math.floor(value / 256);
	}
	return result;
};
const klv = (key: string, data: Uint8Array) => join(hex(key), hex('83'), integer(data.length, 3), data);
const item = (tag: number, data: Uint8Array) => join(integer(tag, 2), integer(data.length, 2), data);

// Parser-only AVC slices. Timing and positive GOP distances model the observed Doremi layout.
export const makeOpAtomMxf = (options: {
	rate?: [number, number]; audio?: boolean; externalPackage?: boolean; op1a?: boolean;
	changedParameters?: boolean; frameSize?: number; standard?: boolean;
	splitIndex?: boolean; missingNextEntry?: boolean;
} = {}) => {
	const rate = options.rate ?? [24, 1];
	const base = makeMxf({ avc: true, videoOnly: !options.audio, opAtom: !options.op1a,
		legacyAvc: !options.standard, indexSid: 2, metadataDuration: 12, editRate: rate,
		externalPackage: options.externalPackage });
	const prefix = base.data.slice(0, base.firstPayloadOffset - 20);
	const payloads: Uint8Array[] = [];
	const packets: Uint8Array[] = [];
	const entries: Uint8Array[] = [];
	let offset = 0;
	for (let i = 0; i < 12; i++) {
		const recovery = options.standard ? i % 4 === 0 : [0, 5, 9].includes(i);
		// Generated Main-profile SPS: progressive 1280x720, one reference, no crop/VUI.
		const ue = (n: number) => '0'.repeat((n + 1).toString(2).length - 1) + (n + 1).toString(2);
		let bits = ue(0) + ue(0) + ue(0) + ue(0) + ue(1) + '0' + ue(79) + ue(44) + '11001';
		bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
		const sps = Uint8Array.of(0x67, 77, 64, options.changedParameters && i === 5 ? 40 : 41,
			...Array.from({ length: bits.length / 8 }, (_, j) => Number.parseInt(bits.slice(j * 8, j * 8 + 8), 2)));
		const data = join(...(recovery ? [hex('00000001'), sps, hex('0000000168ee3c80')] : []),
			hex(i === 0 || (options.standard && recovery) ? '000000016588' : '000000014188'));
		const payload = new Uint8Array(options.frameSize ?? 128);
		payload.set(data);
		payload[payload.length - 1] = i + 1;
		payloads.push(payload);
		const packet = klv('060e2b34010201010d01030115010500', payload);
		packets.push(packet);
		const timing = options.standard
			? Uint8Array.of([0, 1, 1, 254][i % 4]!, (256 - i % 4) % 256, [0xc4, 0x26, 0x37, 0x33][i % 4]!)
			: Uint8Array.of([0, 1, 1, 1, 253, 1, 1, 1, 253, 1, 1, 254][i]!,
					i - (i < 5 ? 0 : i < 9 ? 5 : 9), recovery ? 0xc0 : [1, 9].includes(i) ? 0x22 : 0x33);
		entries.push(join(timing, integer(offset, 8)));
		offset += packet.length;
	}
	const ranges = options.splitIndex ? [[0, 6], [options.missingNextEntry ? 7 : 6, 12]] as const : [[0, 12]] as const;
	const segments = ranges.map(([start, end]) => klv('060e2b34025301010d01020101100100', join(
		item(0x3c0a, integer(100 + start, 16)), item(0x3f0b, join(integer(rate[0], 4), integer(rate[1], 4))),
		item(0x3f0c, integer(start, 8)), item(0x3f0d, integer(end - start, 8)), item(0x3f05, integer(0, 4)),
		item(0x3f06, integer(2, 4)), item(0x3f07, integer(1, 4)),
		item(0x3f08, integer(0, 1)), item(0x3f0e, integer(0, 1)),
		item(0x3f09, join(integer(1, 4), integer(6, 4), hex('ff0000000000'))),
		item(0x3f0a, join(integer(end - start, 4), integer(11, 4), ...entries.slice(start, end))),
	)));
	const index = join(...segments);
	const footerOffset = prefix.length + offset;
	const footer = base.data.slice(base.footerOffset);
	footer.set(integer(footerOffset, 8), 28);
	footer.set(integer(prefix.length - footer.length, 8), 36);
	footer.set(integer(footerOffset, 8), 44);
	footer.set(integer(index.length, 8), 60);
	footer.set(integer(2, 4), 68);
	prefix.set(integer(footerOffset, 8), 44);
	const data = join(prefix, ...packets, footer, index);
	const firstSegmentEnd = footerOffset + footer.length + segments[0]!.length;
	return { data, payloads, bodyStart: prefix.length, footerOffset,
		entries: data.subarray(firstSegmentEnd - ranges[0][1] * 11, firstSegmentEnd) };
};
