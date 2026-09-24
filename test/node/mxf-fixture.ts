// Synthetic ST 377-1 metadata and KLV payloads, not copied from a media file.
// Picture payloads contain only a ProRes frame header, sufficient for demuxing tests, not decoding.
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const join = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
const integer = (value: number, length: number) => {
	const output = new Uint8Array(length);
	for (let i = length - 1; i >= 0; i--) {
		output[i] = value % 256;
		value = Math.floor(value / 256);
	}
	return output;
};
const ref = (id: number) => integer(id, 16);
const umid = (id: number) => join(bytes('060a2b340101010501010d2013000000'), ref(id));
const batch = (...items: Uint8Array[]) => join(integer(items.length, 4), integer(16, 4), ...items);
const audioRate = join(integer(48000, 4), integer(1, 4));
const picture = bytes('060e2b34040101010103020201000000');
const sound = bytes('060e2b34040101010103020202000000');
const proresContainer = bytes('060e2b340401010d0d010301021c0100');
const pcmContainer = bytes('060e2b34040101010d01030102060300');
const op1a = bytes('060e2b34040101010d01020101010900');

const labels: Record<number, string> = {
	0x3c0a: '060e2b34010101010101150200000000',
	0x3b03: '060e2b34010101020601010402010000',
	0x1901: '060e2b34010101020601010405010000',
	0x1902: '060e2b34010101020601010405020000',
	0x4401: '060e2b34010101010101151000000000',
	0x4403: '060e2b34010101020601010406050000',
	0x4701: '060e2b34010101020601010402030000',
	0x4801: '060e2b34010101020107010100000000',
	0x4804: '060e2b34010101020104010300000000',
	0x4803: '060e2b34010101020601010402040000',
	0x4b01: '060e2b34010101020530040500000000',
	0x4b02: '060e2b34010101020702010301030000',
	0x0201: '060e2b34010101020407010000000000',
	0x0202: '060e2b34010101020702020101030000',
	0x1001: '060e2b34010101020601010406090000',
	0x1201: '060e2b34010101020702010301040000',
	0x1101: '060e2b34010101020601010301000000',
	0x1102: '060e2b34010101020601010302000000',
	0x1103: '060e2b34010101070601010307000000',
	0x2701: '060e2b34010101020601010601000000',
	0x3f07: '060e2b34010101040103040400000000',
	0x3f06: '060e2b34010101040103040500000000',
	0x3006: '060e2b34010101050601010305000000',
	0x3f01: '060e2b340101010406010104060b0000',
	0x3001: '060e2b34010101010406010100000000',
	0x3004: '060e2b34010101020601010401020000',
	0x3005: '060e2b34010101020601010401030000',
	0x3201: '060e2b34010101020401060100000000',
	0x320c: '060e2b34010101010401030104000000',
	0x3203: '060e2b34010101010401050202000000',
	0x3202: '060e2b34010101010401050201000000',
	0x320e: '060e2b34010101010401010101000000',
	0x3401: '060e2b34010101020401050306000000',
	0x3406: '060e2b3401010105040105030b000000',
	0x3407: '060e2b3401010105040105030c000000',
	0x3219: '060e2b34010101090401020101060100',
	0x3210: '060e2b34010101020401020101010200',
	0x3d03: '060e2b34010101050402030101010000',
	0x3d02: '060e2b34010101040402030104000000',
	0x3d07: '060e2b34010101050402010104000000',
	0x3d01: '060e2b34010101040402030304000000',
	0x3d0a: '060e2b34010101050402030201000000',
	0x8000: '060e2b340101010e0420040101010000',
};

export const makeMxf = (options: {
	origin?: number;
	start?: number;
	layout?: number;
	blockAlign?: number;
	remapTags?: boolean;
	unsupportedContainer?: boolean;
	externalPackage?: boolean;
	wrongBodySid?: boolean;
	waveAudio?: boolean;
	materialIdOffset?: number;
	channelSelection?: boolean;
	padding?: 'initial' | 'later' | 'both';
	pcmDescriptorRate?: [number, number];
	videoPacketCount?: number;
	metadataDuration?: number;
	editRate?: [number, number];
	indexSid?: number;
	audioLocked?: boolean;
	avc?: boolean;
	videoOnly?: boolean;
	opAtom?: boolean;
	legacyAvc?: boolean;
	htj2k?: { data: Uint8Array; bits: number; width?: number; height?: number };
} = {}) => {
	const rate = options.editRate
		? join(integer(options.editRate[0], 4), integer(options.editRate[1], 4))
		: join(integer(60000, 4), integer(1001, 4));
	const audioContainer = options.waveAudio ? bytes('060e2b34040101010d01030102060100') : pcmContainer;
	const avcContainer = bytes(options.legacyAvc
		? '060e2b34040101020d01030102106001'
		: '060e2b340401010a0d01030102106001');
	const audioTrackNumber = options.waveAudio ? 0x16020100 : 0x16020300;
	const videoTrackNumber = options.avc ? 0x15010500 : options.htj2k ? 0x15010801 : 0x15011700;
	const sourceReference = umid(4);
	const htProperties: Record<number, Uint8Array> = options.htj2k
		? {
				0x3401: Uint8Array.of(82, options.htj2k.bits, 71, options.htj2k.bits, 66, options.htj2k.bits,
					0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
				0x3406: integer(2 ** options.htj2k.bits - 1, 4), 0x3407: integer(0, 4),
				0x3219: bytes('060e2b34040101060401010103030000'),
				0x3210: bytes('060e2b34040101010401010101020000'),
			}
		: {};
	const pcmDescriptorRate = options.pcmDescriptorRate
		? join(integer(options.pcmDescriptorRate[0], 4), integer(options.pcmDescriptorRate[1], 4))
		: audioRate;
	if (options.externalPackage) sourceReference[0] = 0x07;
	const tag = (value: number) => options.remapTags ? (value + 0x4000) & 0xffff : value;
	const item = (key: number, value: Uint8Array) => join(integer(tag(key), 2), integer(value.length, 2), value);
	const klv = (key: string, value: Uint8Array) => join(bytes(key), bytes('83'), integer(value.length, 3), value);
	const set = (kind: number, id: number, fields: Record<number, Uint8Array>) => klv(
		`060e2b34025301010d0101010101${kind.toString(16).padStart(2, '0')}00`,
		join(item(0x3c0a, ref(id)), ...Object.entries(fields).map(([key, value]) => item(Number(key), value))),
	);
	const sets: Uint8Array[] = [
		set(0x2f, 1, { 0x3b03: ref(2) }),
		set(0x18, 2, { 0x1901: batch(ref(3), ref(4)), 0x1902: batch(ref(5)) }),
		set(0x36, 3, { 0x4401: umid(3),
			0x4403: options.videoOnly ? batch(ref(10)) : batch(ref(10), ref(20), ref(30)) }),
		set(0x37, 4, { 0x4401: umid(4),
			0x4403: options.videoOnly ? batch(ref(13)) : batch(ref(13), ref(23), ref(33)),
			0x4701: ref(options.videoOnly ? 16 : 6) }),
		set(0x23, 5, { 0x2701: umid(4), 0x3f07: integer(1, 4), 0x3f06: integer(options.indexSid ?? 0, 4) }),
		...(options.videoOnly ? [] : [set(0x44, 6, { 0x3f01: batch(ref(36), ref(16), ref(26)) })]),
	];
	for (let i = 1; i <= (options.videoOnly ? 1 : 3); i++) {
		const base = i * 10;
		const definition = i === 1 ? picture : sound;
		for (const source of [false, true]) {
			const id = base + (source ? 3 : 0);
			sets.push(set(0x3b, id, {
				0x4801: integer(i + (source ? 0 : options.materialIdOffset ?? 0), 4),
				0x4804: integer(source ? i === 1 ? videoTrackNumber : audioTrackNumber + i - 2 : 0, 4),
				0x4803: ref(id + 1), 0x4b01: rate, 0x4b02: integer(options.origin ?? 0, 8),
			}));
			sets.push(set(0x0f, id + 1, { 0x0201: definition,
				0x0202: integer(options.metadataDuration ?? 5, 8), 0x1001: batch(ref(id + 2)) }));
			const clipFields: Record<number, Uint8Array> = {
				0x0201: definition, 0x0202: integer(options.metadataDuration ?? 5, 8),
				0x1201: integer(options.start ?? 0, 8),
				0x1101: source ? new Uint8Array(32) : sourceReference,
				0x1102: integer(source ? 0 : i, 4),
			};
			if (!source && i > 1 && options.channelSelection) {
				clipFields[0x1103] = join(integer(1, 4), integer(4, 4), integer(1, 4));
			}
			sets.push(set(0x11, id + 2, clipFields));
		}
		sets.push(i === 1
			? set(options.avc ? 0x51 : options.htj2k ? 0x29 : 0x28, base + 6, {
					0x3006: integer(i, 4), 0x3001: rate,
					0x3004: options.htj2k
						? bytes('060e2b340401010d0d010301020c0600')
						: options.avc ? avcContainer : options.unsupportedContainer ? pcmContainer : proresContainer,
					0x3005: options.legacyAvc ? bytes('060e2b340401010a0401020201322001') : new Uint8Array(16),
					0x3201: options.htj2k
						? bytes('060e2b340401010d0401020203010801')
						: options.legacyAvc
							? new Uint8Array(16)
							: bytes(options.avc
									? '060e2b340401010d0401020201314001'
									: '060e2b340401010d0401020203060100'),
					0x320c: integer(options.layout ?? 0, 1),
					0x3203: integer(options.htj2k ? options.htj2k.width ?? 8 : 1280, 4),
					0x3202: integer(options.htj2k ? options.htj2k.height ?? 4 : 720, 4),
					0x320e: options.htj2k
						? join(integer(options.htj2k.width ?? 8, 4), integer(options.htj2k.height ?? 4, 4))
						: join(integer(16, 4), integer(9, 4)),
					...htProperties,
					0x8000: bytes('12345678'),
				})
			: set(options.waveAudio ? 0x48 : 0x47, base + 6, {
					0x3006: integer(i, 4), 0x3001: pcmDescriptorRate, 0x3004: audioContainer, 0x3d03: audioRate,
					0x3d02: integer(options.audioLocked === false ? 0 : 1, 1),
					0x3d07: integer(1, 4), 0x3d01: integer(24, 4), 0x3d0a: integer(options.blockAlign ?? 3, 2),
				}));
	}
	const primer = klv('060e2b34020501010d01020101050100', join(
		integer(Object.keys(labels).length, 4), integer(18, 4),
		...Object.entries(labels).map(([key, value]) => join(integer(tag(Number(key)), 2), bytes(value))),
	));
	const metadata = join(primer, ...sets);
	const partition = (
		kind: number, offset: number, headerSize: number, bodySid: number, indexSize = 0, kag = 1,
	) => klv(
		`060e2b34020501010d010201010${kind}0400`, join(
			integer(1, 2), integer(3, 2), integer(kag, 4), integer(offset, 8), integer(0, 8), integer(0, 8),
			integer(headerSize, 8), integer(indexSize, 8), integer(indexSize ? 2 : 0, 4),
			integer(0, 8), integer(bodySid, 4), options.opAtom ? bytes('060e2b34040101010d01020110000000') : op1a,
			options.opAtom
				? options.legacyAvc
					? batch(bytes('060e2b34040101030d010301027f0100'), bytes('060e2b34040101020d01030102106001'))
					: batch(bytes('060e2b340401010a0d01030102106001'))
				: batch(proresContainer, audioContainer),
		),
	);
	const empty = new Uint8Array(0);
	const index = klv('060e2b34025301010d01020101100100', bytes('3f060004000000023f07000400000001'));
	const alignmentFill = (offset: number, legacy = false) => {
		let size = (256 - offset % 256) % 256;
		if (size === 0) return empty;
		if (size < 20) size += 256;
		return klv(legacy ? '060e2b34010101010301021001000000' : '060e2b34010101020301021001000000',
			new Uint8Array(size - 20));
	};
	const partitionWithRegions = (
		kind: number, offset: number, headerData: Uint8Array, bodySid: number, padded: boolean,
	) => {
		const packSize = partition(kind, offset, 0, bodySid).length;
		const beforeHeader = padded && headerData.length ? alignmentFill(packSize, true) : empty;
		const headerEnd = packSize + beforeHeader.length + headerData.length;
		const afterHeader = padded && headerData.length ? alignmentFill(headerEnd) : empty;
		const beforeIndex = padded ? alignmentFill(headerEnd + afterHeader.length) : empty;
		const indexData = padded ? index : empty;
		const afterIndex = padded
			? alignmentFill(headerEnd + afterHeader.length + beforeIndex.length + indexData.length)
			: empty;
		return join(partition(kind, offset, headerData.length + afterHeader.length, bodySid,
			indexData.length + afterIndex.length, padded ? 256 : 1),
		beforeHeader, headerData, afterHeader, beforeIndex, indexData, afterIndex);
	};
	const paddedInitial = options.padding === 'initial' || options.padding === 'both';
	const paddedLater = options.padding === 'later' || options.padding === 'both';
	const header = partitionWithRegions(2, 0, metadata, 0, paddedInitial);
	const body = partitionWithRegions(3, header.length, paddedLater ? metadata : empty,
		options.wrongBodySid ? 2 : 1, paddedLater);
	const packets: Uint8Array[] = [];
	const payloads: Uint8Array[] = [];
	const videoPacketCount = options.videoPacketCount ?? 5;
	for (let i = 0; i < Math.max(5, videoPacketCount); i++) {
		const frame = new Uint8Array(40);
		frame.set(integer(40, 4));
		frame.set(bytes('69637066001c000061706c30050002d08000091009'), 4);
		frame[39] = i;
		if (i < videoPacketCount) {
			const payload = options.htj2k?.data ?? frame;
			payloads.push(payload);
			packets.push(klv(`060e2b34010201010d010301${videoTrackNumber.toString(16)}`, payload));
		}
		if (i >= 5 || options.videoOnly) continue;
		const samples = i === 2 ? 800 : 801;
		packets.push(klv(`060e2b34010201010d010301${audioTrackNumber.toString(16)}`,
			new Uint8Array(samples * 3).fill(i)));
		packets.push(klv(`060e2b34010201010d010301${(audioTrackNumber + 1).toString(16)}`,
			new Uint8Array(samples * 3).fill(i + 10)));
	}
	const prefix = join(header, body);
	const essence = join(...packets);
	return {
		data: join(prefix, essence, partitionWithRegions(4, prefix.length + essence.length, empty, 0, paddedLater)),
		payloads,
		firstPayloadOffset: prefix.length + 20,
		footerOffset: prefix.length + essence.length,
	};
};
