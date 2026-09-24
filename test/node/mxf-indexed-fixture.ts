import { makeMxf } from './mxf-fixture.js';

const integer = (value: number, length: number) => {
	const bytes = new Uint8Array(length);
	for (let i = length - 1; i >= 0; i--) {
		bytes[i] = value % 256;
		value = Math.floor(value / 256);
	}
	return bytes;
};
const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const join = (...values: Uint8Array[]) => Uint8Array.from(Buffer.concat(values));
const klv = (key: string, value: Uint8Array) => join(hex(key), integer(0x83, 1), integer(value.length, 3), value);

// Ten GB of logical essence, with only metadata and index bytes allocated. Each content package
// contains system data, picture, and two mono PCM elements, separated by an indexed slice.
export const makeIndexedMxf = (options: {
	cbe?: boolean; noRip?: boolean; ber?: boolean; unlockedAudio?: boolean;
	padding?: boolean; repeatIndex?: boolean; exceptionalCbe?: boolean; extraEssence?: boolean;
	avc?: boolean;
	htj2k?: { data: Uint8Array; bits: number; width?: number; height?: number };
	frameSize?: number;
	avcSps?: Uint8Array;
	avcNonIdrAt?: number;
	avcMissingParametersAt?: number;
	avcChangedParametersAt?: number;
	editRate?: [number, number];
} = {}) => {
	const item = (tag: number, value: Uint8Array) => join(integer(tag, 2),
		options.ber ? join(integer(0x83, 1), integer(value.length, 3)) : integer(value.length, 2), value);
	const count = 10000;
	const frameSize = options.htj2k?.data.length ?? options.frameSize ?? 1024 * 1024;
	const pcmSize = 5760;
	const system = klv('060e2b34020501010d01030104010100', new Uint8Array(12));
	const pictureOffset = system.length;
	const audioOffset = pictureOffset + 20 + frameSize;
	const stride = audioOffset + 2 * (20 + pcmSize);
	const metadataCount = count - (options.extraEssence ? 1 : 0);
	const rate: [number, number] = options.editRate ?? [25, 1];
	const base = makeMxf({ metadataDuration: metadataCount, editRate: rate, indexSid: 2,
		audioLocked: !options.unlockedAudio, avc: options.avc, htj2k: options.htj2k });
	const header = base.data.slice(0, base.firstPayloadOffset - 20 - 140);
	const partition = (kind: number, offset: number, previous: number, footer: number,
		bodyOffset: number, bodySid: number, indexSize = 0) => klv(
		`060e2b34020501010d010201010${kind}0400`, join(
			integer(1, 2), integer(3, 2), integer(1, 4), integer(offset, 8), integer(previous, 8), integer(footer, 8),
			integer(0, 8), integer(indexSize, 8), integer(indexSize ? 2 : 0, 4), integer(bodyOffset, 8),
			integer(bodySid, 4), hex('060e2b34040101010d01020101010900'), integer(0, 4), integer(16, 4),
		),
	);
	const packSize = 108;
	const starts = [0, 4000, 8000];
	const padding = options.padding ? 64 : 0;
	const firstExtra = options.exceptionalCbe ? 64 : 0;
	const fill = klv('060e2b34010101020301021001000000', new Uint8Array(44));
	const streamOffset = (frame: number) => frame * stride + Math.floor(frame / 4000) * padding
		+ (frame > 0 ? firstExtra : 0);
	const offsets = starts.map((frame, i) => header.length + streamOffset(frame) + i * (packSize + padding));
	let footerOffset = header.length + count * stride + firstExtra + starts.length * (packSize + 2 * padding);
	const segments: Uint8Array[] = [];
	const segmentSize = options.ber || options.cbe ? count : options.avc ? 1999 : 2000;
	const ranges: [number, number][] = options.exceptionalCbe
		? [[0, 1], [1, count - 1]]
		: Array.from({ length: Math.ceil(count / segmentSize) }, (_, i) =>
				[i * segmentSize, Math.min(segmentSize, count - i * segmentSize)]);
	for (const [start, length] of ranges) {
		const entries: Uint8Array[] = [];
		if (!options.cbe) {
			for (let i = start; i < start + length; i++) {
				const timing = options.avc
					? Uint8Array.of([0, 1, 1, 254][i % 4]!, (256 - i % 4) % 256,
							[0xc4, 0x26, 0x37, 0x33][i % 4]!)
					: hex('000080');
				entries.push(join(timing, integer(streamOffset(i), 8), integer(audioOffset, 4)));
			}
		}
		segments.push(klv(options.ber ? '060e2b34021301010d01020101100100' : '060e2b34025301010d01020101100100', join(
			item(0x3c0a, integer(start + 1, 16)),
			item(0x3f0b, join(integer(rate[0], 4), integer(rate[1], 4))),
			item(0x3f0c, integer(start, 8)), item(0x3f0d, integer(Math.min(length, metadataCount - start), 8)),
			item(0x3f05, integer(options.cbe ? stride + (start === 0 ? firstExtra : 0) : 0, 4)),
			item(0x3f06, integer(2, 4)), item(0x3f07, integer(1, 4)),
			item(0x3f08, integer(options.cbe ? 0 : 1, 1)), item(0x3f0e, integer(0, 1)),
			item(0x3f09, join(integer(4, 4), integer(6, 4),
				integer(0, 6), join(hex(options.avc ? 'ff00' : '0000'), integer(pictureOffset, 4)),
				join(integer(0, 1), integer(options.cbe ? 0 : 1, 1), integer(options.cbe ? audioOffset : 0, 4)),
				join(integer(0, 1), integer(options.cbe ? 0 : 1, 1),
					integer((options.cbe ? audioOffset : 0) + 20 + pcmSize, 4)))),
			...(options.cbe ? [] : [item(0x3f0a, join(integer(length, 4), integer(15, 4), ...entries))]),
		)));
	}
	const index = join(...segments);
	const repeatOffset = footerOffset;
	if (options.repeatIndex) footerOffset += packSize + index.length;
	header.set(integer(footerOffset, 8), 20 + 24);
	const footer = join(partition(4, footerOffset, options.repeatIndex ? repeatOffset : offsets[2]!,
		footerOffset, 0, 0, index.length), index);
	const ripSize = 20 + (starts.length + 2 + (options.repeatIndex ? 1 : 0)) * 12 + 4;
	const rip = options.noRip
		? new Uint8Array(0)
		: klv('060e2b34020501010d01020101110100', join(
				integer(0, 4), integer(0, 8),
				...offsets.map(offset => join(integer(1, 4), integer(offset, 8))),
				...(options.repeatIndex ? [join(integer(0, 4), integer(repeatOffset, 8))] : []),
				integer(0, 4), integer(footerOffset, 8), integer(ripSize, 4),
			));
	const regions = [{ offset: 0, data: header }, ...offsets.map((offset, i) => ({ offset,
		data: join(partition(3, offset, offsets[i - 1] ?? 0, footerOffset, streamOffset(starts[i]!), 1),
			...(padding ? [fill] : [])) })),
	...(options.repeatIndex
		? [{ offset: repeatOffset,
				data: join(partition(3, repeatOffset, offsets[2]!, footerOffset, 0, 0, index.length), index) }]
		: []),
	{ offset: footerOffset, data: join(footer, rip) }];
	const reads: [number, number][] = [];
	const size = footerOffset + footer.length + rip.length;
	return { size, reads, count, frameSize, footerOffset, offsets, stride, regions,
		read: (start: number, end: number) => {
			reads.push([start, end]);
			const result = new Uint8Array(end - start);
			const copy = (offset: number, data: Uint8Array) => {
				const low = Math.max(start, offset);
				const high = Math.min(end, offset + data.length);
				if (low < high) result.set(data.subarray(low - offset, high - offset), low - start);
			};
			for (const region of regions) copy(region.offset, region.data);
			for (let p = 0; p < starts.length; p++) {
				const body = offsets[p]! + packSize + padding;
				const length = (starts[p + 1] ?? count) - starts[p]!;
				if (padding) copy(body + length * stride + (p === 0 ? firstExtra : 0), fill);
				if (p === 0 && firstExtra) copy(body + stride, fill);
				const first = Math.max(0, Math.floor((start - body - firstExtra) / stride));
				const last = Math.min(length - 1, Math.floor((end - 1 - body) / stride));
				for (let i = first; i <= last; i++) {
					const offset = body + i * stride + (p === 0 && i > 0 ? firstExtra : 0);
					copy(offset, system);
					copy(offset + pictureOffset,
						join(hex(options.htj2k
							? '060e2b34010201010d0103011501080183'
							: options.avc
								? '060e2b34010201010d0103011501050083'
								: '060e2b34010201010d0103011501170083'), integer(frameSize, 3)));
					const frame = new Uint8Array(options.avc ? 128 : 40);
					if (options.avc) {
						// SPS/PPS from generated testsrc2, followed by a demux-only slice stub, not decodable media.
						const defaultSps = hex('6764001facd9405005bb011000000300100000030320f1831960');
						const sps = (options.avcSps ?? defaultSps).slice();
						if (starts[p]! + i === options.avcChangedParametersAt) sps[3] = 32;
						const idr = i % 4 === 0 && starts[p]! + i !== options.avcNonIdrAt;
						const slice = hex('0000000168ebe2cb22c000000001' + (idr ? '65' : '41') + '88');
						frame.set(starts[p]! + i === options.avcMissingParametersAt
							? hex('000000016588')
							: join(hex('00000001'), sps, slice));
					} else {
						frame.set(integer(frameSize, 4));
						frame.set(hex('69637066001c000061706c30050002d08000091009'), 4);
					}
					frame[frame.length - 1] = (starts[p]! + i) % 256;
					copy(offset + pictureOffset + 20, options.htj2k?.data ?? frame);
					for (let a = 0; a < 2; a++) {
						const shorter = options.unlockedAudio && starts[p] === 0 && i === 0 && a === 0;
						copy(offset + audioOffset + a * (20 + pcmSize),
							join(hex(`060e2b34010201010d0103011602030${a}83`),
								integer(pcmSize - (shorter ? 30 : 0), 3)));
						if (shorter) {
							copy(offset + audioOffset + 20 + pcmSize - 30,
								klv('060e2b34010101020301021001000000', new Uint8Array(10)));
						}
					}
				}
			}
			return result;
		},
	};
};
