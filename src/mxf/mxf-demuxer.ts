/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, extractVideoCodecString } from '../codec';
import {
	AvcDecoderConfigurationRecord, extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord, extractNalUnitTypeForHevc, HevcNalUnitType,
	extractNalUnitTypeForAvc, extractProresCodecInfoFromPacket,
	iterateNalUnitsInAnnexB, parseAvcSps, parseHevcSps,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { InputDisposedError } from '../input';
import {
	InputAudioTrackBacking, InputTrackBacking, InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	COLOR_PRIMARIES_MAP_INVERSE, IDENTITY_MATRIX, MATRIX_COEFFICIENTS_MAP_INVERSE, MaybePromise,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE, UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	batch, equalRationals, hex, MetadataSet, P, parseSet, position, property, rational, requireMxf, uint,
} from './mxf-metadata';
import { FILL_KEYS, INDEX_KEYS, MxfIndex, MxfKlv as Klv, PARTITION_PREFIX } from './mxf-index';
import { checkAes3ChannelStatus, parseSt331Header, St331Header, unpackSt331 } from './mxf-aes3';

const PRIMER = '060e2b34020501010d01020101050100';
const SET_PREFIX = '060e2b34025301010d0101010101';
const ESSENCE_PREFIX = '060e2b34010201010d010301';
// SMPTE RDD 44 frame-wrapped ProRes mapping.
const PRORES_CONTAINER = '060e2b340401010d0d010301021c0100';
const AVC_CONTAINER = '060e2b340401010a0d01030102106001';
const HEVC_CONTAINER = '060e2b340401010d0d01030102206001';
const HEVC_SUB_DESCRIPTOR = '060e2b34025301010d01010101018101';
const LEGACY_AVC_CONTAINER = '060e2b34040101020d01030102106001';
// ST 382 AES/BWF carries packed little-endian samples, not ST 331 AES3 subframes.
const WAVE_CONTAINER = '060e2b34040101010d01030102060100';
const AES_CONTAINER = '060e2b34040101010d01030102060300';
// ST 386 defined templates, not extended templates or picture-only mappings.
const d10Variant = (container: string) => /^060e2b34040101010d01030102010[1-6]01$/.test(container)
	? Number.parseInt(container.slice(28, 30), 16)
	: 0;
const PICTURE = '060e2b34040101010103020201000000';
const SOUND = '060e2b34040101010103020202000000';
const TIMECODE = '060e2b34040101010103020101000000';
const DESCRIPTIVE_METADATA = '060e2b34040101010103020110000000';
const PROFILES = ['apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x'];
const AVC_PROFILES: Record<string, number> = {
	'0401020201312001': 77,
	'0401020201314001': 100,
	'0401020201315001': 110,
	'0401020201316001': 122,
};
const HEVC_PROFILES: Record<string, number> = {
	'0401020201411001': 1, '0401020201412001': 2, '0401020201422001': 4,
};
type AvciFormat = { profile: 110 | 122; width: number; height: number; size: number;
	baseLevel: number; rates: number[]; denominator: number; };
// RP 2027 progressive Class 50/100 leaves; sizes include the complete in-band header block.
const AVCI_FORMATS: Record<string, AvciFormat> = {
	'0401020201322103': { profile: 110, width: 1440, height: 1080, size: 232960,
		baseLevel: 40, rates: [24000, 30000, 60000], denominator: 1001 },
	'0401020201322104': { profile: 110, width: 1440, height: 1080, size: 281088,
		baseLevel: 40, rates: [25, 50], denominator: 1 },
	'0401020201322108': { profile: 110, width: 960, height: 720, size: 116736,
		baseLevel: 32, rates: [24000, 30000, 60000], denominator: 1001 },
	'0401020201322109': { profile: 110, width: 960, height: 720, size: 140800,
		baseLevel: 32, rates: [25, 50], denominator: 1 },
	'0401020201323103': { profile: 122, width: 1920, height: 1080, size: 472576,
		baseLevel: 41, rates: [24000, 30000, 60000], denominator: 1001 },
	'0401020201323104': { profile: 122, width: 1920, height: 1080, size: 568832,
		baseLevel: 41, rates: [25, 50], denominator: 1 },
	'0401020201323108': { profile: 122, width: 1280, height: 720, size: 236544,
		baseLevel: 41, rates: [24000, 30000, 60000], denominator: 1001 },
	'0401020201323109': { profile: 122, width: 1280, height: 720, size: 284672,
		baseLevel: 41, rates: [25, 50], denominator: 1 },
};
const avcParameterSets = (record: AvcDecoderConfigurationRecord) => [
	...record.sequenceParameterSets, ...record.pictureParameterSets,
].map(hex).sort().join(':');

type PacketLocation = {
	offset: number; size: number; timestamp: number; duration: number; isKey?: boolean; prefetchEnd?: number;
	requiresParameters?: boolean;
	byteLength?: number;
	st331?: St331Header;
};
type TrackInfo = {
	id: number;
	number: number;
	bodySid: number;
	indexSid: number;
	trackNumber: number;
	rate: { numerator: number; denominator: number };
	duration: number;
	editUnitCount: number;
	descriptor: MetadataSet;
	hevcSubDescriptor?: MetadataSet;
	packets: PacketLocation[];
	sampleCount: number;
	legacyAvc: boolean;
	avci?: boolean;
	opAtom: boolean;
};

export class MxfDemuxer extends Demuxer {
	private metadataPromise: Promise<void> | null = null;
	private scanPromise: Promise<void> | null = null;
	private tracks: MxfTrackBacking[] = [];
	private scanOffset = 0;
	private bodySid = 0;
	private ended = false;
	private footerSeen = false;
	private disposed = false;
	private metadataTags: MetadataTags = {};
	private index: MxfIndex | null = null;
	private opAtom = false;
	private essenceContainers: string[] = [];

	checkDisposed() {
		if (this.disposed) {
			throw new InputDisposedError();
		}
	}

	async bytes(offset: number, size: number, prefetchEnd = offset + size) {
		this.checkDisposed();
		requireMxf(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(size) && size >= 0
			&& Number.isSafeInteger(offset + size) && offset + size <= this.input._reader.fileSize!,
		'invalid byte range');
		const slice = await this.input._reader.source._read(
			offset, offset + size, offset, prefetchEnd,
		);
		this.checkDisposed();
		requireMxf(slice, 'truncated data');
		return slice.bytes.subarray(offset - slice.offset, offset - slice.offset + size);
	}

	async klv(offset: number): Promise<Klv> {
		const header = await this.bytes(offset, Math.min(25, this.input._reader.fileSize! - offset));
		requireMxf(header.length >= 17, 'truncated KLV header');
		const first = header[16]!;
		let size = first;
		let start = offset + 17;
		if (first & 0x80) {
			const count = first & 0x7f;
			requireMxf(count > 0 && count <= 8, 'indefinite or oversized BER length');
			requireMxf(header.length >= 17 + count, 'truncated BER length');
			size = uint(header.subarray(17, 17 + count), count);
			start += count;
		}
		const end = start + size;
		requireMxf(Number.isSafeInteger(end) && end <= this.input._reader.fileSize!, 'KLV exceeds file');
		return { key: hex(header.subarray(0, 16)), offset: start, size, end, lengthSize: start - offset - 16 };
	}

	async partition(klv: Klv, offset: number) {
		requireMxf(klv.size >= 88 && klv.size <= 4096, 'partition pack size');
		const data = await this.bytes(klv.offset, klv.size);
		requireMxf(uint(data.subarray(0, 2), 2) === 1, 'partition version');
		requireMxf(uint(data.subarray(8, 16), 8) === offset, 'partition offset');
		for (const start of [16, 24, 52]) {
			uint(data.subarray(start, start + 8), 8);
		}
		const op = hex(data.subarray(64, 80));
		const opAtom = op === '060e2b34040101010d01020110000000';
		requireMxf(opAtom || (op.startsWith('060e2b34040101010d0102010101') && op.endsWith('00')
			&& (data[78]! & 2) === 0), 'only self-contained OP1a or single-file OPAtom is supported');
		if (offset === 0) {
			this.opAtom = opAtom;
		} else {
			requireMxf(opAtom === this.opAtom, 'partition operational pattern mismatch');
		}
		const containers = batch(data.subarray(80), 16).map(hex);
		if (offset === 0) {
			this.essenceContainers = containers;
		} else if (this.essenceContainers.some(d10Variant)) {
			requireMxf(containers.length === this.essenceContainers.length
				&& containers.every(container => this.essenceContainers.includes(container)),
			'D-10 partition essence containers mismatch');
		}
		if (opAtom) {
			requireMxf((containers.length === 1 && containers[0] === AVC_CONTAINER)
				|| (containers.length === 2 && containers.includes(LEGACY_AVC_CONTAINER)
					&& containers.includes('060e2b34040101030d010301027f0100')),
			'unsupported OPAtom essence containers');
			if (offset !== 0) {
				requireMxf(containers.length === this.essenceContainers.length
					&& containers.every(container => this.essenceContainers.includes(container)),
				'partition essence containers mismatch');
			}
		}
		return {
			headerSize: uint(data.subarray(32, 40), 8),
			indexSize: uint(data.subarray(40, 48), 8),
			bodySid: uint(data.subarray(60, 64), 4),
			indexSid: uint(data.subarray(48, 52), 4),
			previous: uint(data.subarray(16, 24), 8),
			footer: uint(data.subarray(24, 32), 8),
			bodyOffset: uint(data.subarray(52, 60), 8),
		};
	}

	private readMetadata() {
		return this.metadataPromise ??= this.initialize();
	}

	async countedRegion(offset: number, size: number, kind: 'header' | 'index') {
		if (size === 0) {
			return { start: offset, end: offset };
		}
		// Leading alignment Fill can only move the region's end later, so this window stays before essence.
		await this.bytes(offset, Math.min(size, 4096));
		let first = await this.klv(offset);
		while (FILL_KEYS.includes(first.key)) {
			offset = first.end;
			first = await this.klv(offset);
		}
		requireMxf(kind === 'header' ? first.key === PRIMER : INDEX_KEYS.includes(first.key),
			`missing ${kind} region start`);
		// ST 377-1 counts from the Primer/first index key, excluding leading alignment Fill.
		const end = offset + size;
		requireMxf(Number.isSafeInteger(end) && end <= this.input._reader.fileSize! && first.end <= end,
			`${kind} region exceeds file or splits KLV`);
		return { start: offset, end };
	}

	private async initialize() {
		requireMxf(this.input._reader.fileSize !== null, 'a seekable source with known size is required');
		await this.bytes(0, Math.min(105, this.input._reader.fileSize));
		const first = await this.klv(0);
		requireMxf(first.key === `${PARTITION_PREFIX}020400`, 'closed complete header at byte zero required');
		const partition = await this.partition(first, 0);
		requireMxf(partition.headerSize > 0 && partition.headerSize <= 16 * 1024 * 1024,
			'header metadata size');
		const header = await this.countedRegion(first.end, partition.headerSize, 'header');
		await this.bytes(header.start, header.end - header.start);
		const primer = new Map<number, string>();
		const sets = new Map<string, MetadataSet>();
		let offset = header.start;
		while (offset < header.end) {
			const klv = await this.klv(offset);
			requireMxf(klv.end <= header.end, 'KLV exceeds header metadata');
			if (klv.key === PRIMER) {
				requireMxf(primer.size === 0 && klv.size <= 2 * 1024 * 1024, 'duplicate or oversized primer');
				for (const item of batch(await this.bytes(klv.offset, klv.size), 18)) {
					const tag = uint(item.subarray(0, 2), 2);
					requireMxf(!primer.has(tag), 'duplicate primer tag');
					primer.set(tag, hex(item.subarray(2)));
				}
			} else if (klv.key.startsWith(SET_PREFIX)) {
				requireMxf(klv.size <= 1024 * 1024 && sets.size < 10000, 'metadata limit exceeded');
				const set = parseSet(klv.key, await this.bytes(klv.offset, klv.size), primer);
				const id = hex(property(set, P.instance, 16));
				requireMxf(!sets.has(id), 'duplicate instance UID');
				sets.set(id, set);
			}
			offset = klv.end;
		}
		this.buildTracks(sets);
		this.scanOffset = (await this.countedRegion(header.end, partition.indexSize, 'index')).end;
		this.bodySid = partition.bodySid;
		this.index = new MxfIndex(this, this.input._reader.fileSize, partition.footer);
	}

	private buildTracks(sets: Map<string, MetadataSet>) {
		const resolve = (ref: Uint8Array) => {
			requireMxf(ref.length === 16, 'invalid strong reference');
			const set = sets.get(hex(ref));
			requireMxf(set, 'unresolved metadata reference');
			return set;
		};
		const refs = (set: MetadataSet, key: string) => batch(property(set, key), 16).map(resolve);
		const prefaces = [...sets.values()].filter(x => x.kind === 0x2f);
		requireMxf(prefaces.length === 1, 'one Preface required');
		const content = resolve(property(prefaces[0]!, P.content));
		const packages = refs(content, P.packages);
		const materials = packages.filter(x => x.kind === 0x36);
		const sources = packages.filter(x => x.kind === 0x37);
		requireMxf(materials.length === 1 && sources.length === 1, 'one material and one file package required');
		const source = sources[0]!;
		const sourceId = hex(property(source, P.packageId, 32));
		const essenceData = refs(content, P.essenceData);
		requireMxf(!this.opAtom || essenceData.length === 1, 'OPAtom requires one local essence container');
		const essence = essenceData.filter(x => hex(property(x, P.linkedPackage, 32)) === sourceId);
		requireMxf(essence.length === 1, 'one essence container data set required');
		const bodySid = uint(property(essence[0]!, P.bodySid), 4);
		const indexProperty = essence[0]!.properties.get(P.indexSid);
		const indexSid = indexProperty ? uint(indexProperty, 4) : 0;
		requireMxf(bodySid !== 0, 'external essence');
		const descriptor = resolve(property(source, P.descriptor));
		const descriptors = descriptor.kind === 0x44 ? refs(descriptor, P.subDescriptors) : [descriptor];
		requireMxf(!this.opAtom || descriptor.kind !== 0x44, 'OPAtom requires one direct video descriptor');
		requireMxf(!this.opAtom || this.essenceContainers.includes(hex(property(descriptor, P.container))),
			'OPAtom descriptor container disagrees with partition');
		const sourceTracks = refs(source, P.tracks);
		let videos = 0;
		let audios = 0;
		const routes = new Set<number>();
		const ids = new Set<number>();
		for (const track of refs(materials[0]!, P.tracks)) {
			const sequence = resolve(property(track, P.sequence));
			const definition = hex(property(sequence, P.definition, 16));
			if (definition === DESCRIPTIVE_METADATA) {
				requireMxf(track.kind === 0x3a && sequence.kind === 0x0f
					&& uint(property(track, P.trackNumber), 4) === 0
					&& refs(sequence, P.components).every(component => component.kind === 0x41
						&& hex(property(component, P.definition, 16)) === DESCRIPTIVE_METADATA),
				'unsupported descriptive metadata track');
				continue;
			}
			if (definition === TIMECODE) {
				const components = refs(sequence, P.components);
				if (components.length === 1 && components[0]!.kind === 0x14) {
					const timecode = components[0]!;
					this.metadataTags.raw ??= {};
					this.metadataTags.raw[`mxf.timecode.${uint(property(track, P.trackId), 4)}`] = {
						start: String(position(property(timecode, P.timecodeStart))),
						roundedBase: String(uint(property(timecode, P.timecodeBase), 2)),
						dropFrame: String(uint(property(timecode, P.timecodeDrop), 1)),
					};
				}
				continue;
			}
			requireMxf(definition === PICTURE || definition === SOUND, 'unsupported material track data definition');
			requireMxf(track.kind === 0x3b && sequence.kind === 0x0f, 'timeline track and Sequence required');
			requireMxf(position(property(track, P.origin)) === 0, 'nonzero Origin');
			const components = refs(sequence, P.components);
			requireMxf(components.length === 1 && components[0]!.kind === 0x11, 'one SourceClip per track required');
			const clip = components[0]!;
			requireMxf(position(property(clip, P.start)) === 0, 'nonzero StartPosition');
			requireMxf(hex(property(clip, P.sourcePackage, 32)) === sourceId, 'external source package');
			const sourceTrackId = uint(property(clip, P.sourceTrack), 4);
			const matches = sourceTracks.filter(x => uint(property(x, P.trackId), 4) === sourceTrackId);
			requireMxf(matches.length === 1, 'source track reference');
			const sourceTrack = matches[0]!;
			requireMxf(sourceTrack.kind === 0x3b && position(property(sourceTrack, P.origin)) === 0,
				'source Origin/layout');
			const rate = rational(property(track, P.editRate));
			const sourceRate = rational(property(sourceTrack, P.editRate));
			requireMxf(equalRationals(rate, sourceRate), 'material/source edit rate mismatch');
			const sourceSequence = resolve(property(sourceTrack, P.sequence));
			requireMxf(hex(property(sourceSequence, P.definition)) === definition, 'source data definition mismatch');
			const sourceClips = refs(sourceSequence, P.components);
			requireMxf(sourceSequence.kind === 0x0f && sourceClips.length === 1
				&& sourceClips[0]!.kind === 0x11, 'source sequence layout');
			const sourceClip = sourceClips[0]!;
			for (const component of [clip, sourceClip]) {
				requireMxf(!component.properties.has(P.channelIds)
					&& !component.properties.has(P.monoSourceTrackIds), 'source clip channel mapping');
			}
			requireMxf(position(property(sourceClip, P.start)) === 0
				&& property(sourceClip, P.sourcePackage, 32).every(x => x === 0)
				&& uint(property(sourceClip, P.sourceTrack), 4) === 0, 'nonterminal source clip');
			const duration = position(property(sequence, P.duration));
			for (const component of [clip, sourceSequence, sourceClip]) {
				requireMxf(position(property(component, P.duration)) === duration, 'trimmed or mismatched duration');
				requireMxf(hex(property(component, P.definition, 16)) === definition,
					'component data definition mismatch');
			}
			const linked = descriptors.filter(x => uint(property(x, P.linkedTrack), 4) === sourceTrackId);
			requireMxf(linked.length === 1, 'descriptor LinkedTrackID');
			const id = uint(property(track, P.trackId), 4);
			const trackNumber = uint(property(sourceTrack, P.trackNumber), 4);
			requireMxf(!ids.has(id) && !routes.has(trackNumber), 'duplicate track identity');
			ids.add(id);
			routes.add(trackNumber);
			const info: TrackInfo = {
				id, number: definition === PICTURE ? ++videos : ++audios, bodySid, indexSid, trackNumber, rate,
				duration: duration * rate.denominator / rate.numerator,
				editUnitCount: duration,
				descriptor: linked[0]!, packets: [], sampleCount: 0,
				legacyAvc: false,
				opAtom: this.opAtom,
			};
			if (hex(property(info.descriptor, P.container)) === HEVC_CONTAINER
				&& info.descriptor.properties.has(P.essenceSubDescriptors)) {
				const hevc = refs(info.descriptor, P.essenceSubDescriptors).filter(x => x.key === HEVC_SUB_DESCRIPTOR);
				requireMxf(hevc.length <= 1, 'multiple HEVC subdescriptors');
				info.hevcSubDescriptor = hevc[0];
			}
			this.tracks.push(definition === PICTURE
				? d10Variant(hex(property(info.descriptor, P.container)))
					? new MxfD10VideoTrackBacking(this, info)
					: new MxfVideoTrackBacking(this, info)
				: new MxfAudioTrackBacking(this, info));
		}
		for (const track of sourceTracks) {
			const sequence = resolve(property(track, P.sequence));
			requireMxf(hex(property(sequence, P.definition)) === TIMECODE
				|| routes.has(uint(property(track, P.trackNumber), 4)), 'unmapped source track');
		}
		requireMxf(videos > 0 && descriptors.length === this.tracks.length, 'unmapped essence descriptor');
		const d10 = descriptors.filter(d => d10Variant(hex(property(d, P.container))));
		requireMxf(!d10.length || (videos === 1 && audios === 1 && d10.length === 2
			&& hex(property(d10[0]!, P.container)) === hex(property(d10[1]!, P.container))),
		'D-10 requires matching picture and sound defined templates');
		requireMxf(!d10.length || this.essenceContainers.includes(hex(property(d10[0]!, P.container))),
			'D-10 descriptor container disagrees with partition');
		requireMxf(!this.opAtom || (videos === 1 && audios === 0 && this.tracks[0]!.getCodec() === 'avc'),
			'OPAtom requires exactly one AVC video track');
	}

	private async scanOne() {
		if (this.scanOffset === this.input._reader.fileSize) {
			requireMxf(this.footerSeen, 'missing footer partition');
			for (const track of this.tracks) {
				if (track.getType() === 'video') {
					requireMxf(track.info.packets.length === track.info.editUnitCount,
						'picture edit-unit count does not match metadata');
				} else if (d10Variant(hex(property(track.info.descriptor, P.container)))) {
					requireMxf(track.info.packets.length === track.info.editUnitCount,
						'D-10 audio edit-unit count does not match metadata');
				}
			}
			this.ended = true;
			return;
		}
		const offset = this.scanOffset;
		const klv = await this.klv(offset);
		let next = klv.end;
		if (klv.key.startsWith(PARTITION_PREFIX) && ['03', '04'].includes(klv.key.slice(26, 28))) {
			requireMxf(!this.footerSeen, 'partition after footer');
			requireMxf(klv.key.endsWith('0400'), 'open or incomplete partition');
			const partition = await this.partition(klv, offset);
			// Later partition metadata has its own primer and does not replace the closed header snapshot.
			const header = await this.countedRegion(next, partition.headerSize, 'header');
			next = (await this.countedRegion(header.end, partition.indexSize, 'index')).end;
			this.footerSeen = klv.key.slice(26, 28) === '04';
			this.bodySid = partition.bodySid;
		} else if (klv.key.startsWith(ESSENCE_PREFIX)) {
			requireMxf(!this.footerSeen, 'essence after footer');
			const trackNumber = Number.parseInt(klv.key.slice(24), 16);
			const track = this.tracks.find(x => x.info.bodySid === this.bodySid && x.info.trackNumber === trackNumber);
			requireMxf(track, 'unmapped essence element');
			await track.append(klv);
		}
		this.scanOffset = next;
	}

	async scanUntil(done: () => boolean) {
		await this.readMetadata();
		this.checkDisposed();
		while (!done() && !this.ended) {
			const pending = this.scanPromise ??= this.scanOne();
			try {
				await pending;
			} finally {
				if (this.scanPromise === pending) {
					this.scanPromise = null;
				}
			}
		}
	}

	async indexedPacket(index: number, info: TrackInfo, temporal = false) {
		await this.readMetadata();
		this.checkDisposed();
		return info.indexSid ? this.index!.locate(index, info, temporal) : null;
	}

	async resolvePresentation(presentation: number, info: TrackInfo) {
		await this.readMetadata();
		this.checkDisposed();
		const result = await this.index!.resolvePresentation(presentation, info);
		this.checkDisposed();
		return result;
	}

	async resolveDecode(decode: number, info: TrackInfo) {
		await this.readMetadata();
		this.checkDisposed();
		const result = await this.index!.resolveDecode(decode, info);
		this.checkDisposed();
		return result;
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.tracks;
	}

	async getMimeType() {
		return 'application/mxf';
	}

	async getMetadataTags(): Promise<MetadataTags> {
		await this.readMetadata();
		return this.metadataTags;
	}

	override dispose() {
		this.disposed = true;
	}
}

abstract class MxfTrackBacking implements InputTrackBacking {
	protected packetIndices = new WeakMap<EncodedPacket, number>();
	private indexedPackets = new Map<number, Promise<PacketLocation | null>>();
	private indexedEnd = false;

	constructor(public demuxer: MxfDemuxer, public info: TrackInfo) {}
	abstract getType(): 'video' | 'audio';
	abstract getCodec(): 'prores' | 'avc' | 'hevc' | AudioCodec | null;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
	abstract append(klv: Klv): MaybePromise<void>;
	abstract indexedLocation(klv: Klv, index: number): MaybePromise<PacketLocation>;
	canUseIndex() {
		return this.info.indexSid !== 0;
	}

	protected requiresIndex() {
		return this.getCodec() === 'avc' || this.getCodec() === 'hevc';
	}

	protected hasTemporalIndex() {
		return this.requiresIndex() && !this.info.avci;
	}

	abstract getInternalCodecId(): Uint8Array | null;
	getId() {
		return this.info.id;
	}

	getNumber() {
		return this.info.number;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getTimeResolution() {
		return this.info.rate.numerator;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getDisposition() {
		return { ...DEFAULT_TRACK_DISPOSITION };
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata() {
		return this.info.duration;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	getHasOnlyKeyPackets() {
		return true;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	protected readPacket(packet: PacketLocation, index: number) {
		// Only payload reads allow source-managed read-ahead, capped at the containing body partition.
		return this.demuxer.bytes(packet.offset, packet.size, packet.prefetchEnd);
	}

	async packet(index: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (index < 0) {
			return null;
		}
		if (index >= this.info.editUnitCount && this.indexedEnd) {
			return null;
		}
		const packet = await this.location(index);
		this.demuxer.checkDisposed();
		if (!packet) {
			return null;
		}
		const data = options.metadataOnly ? PLACEHOLDER_DATA : await this.readPacket(packet, index);
		const result = new EncodedPacket(data, packet.isKey === false ? 'delta' : 'key',
			packet.timestamp, packet.duration, index, packet.byteLength ?? packet.size);
		this.demuxer.checkDisposed();
		this.packetIndices.set(result, index);
		return result;
	}

	private async indexed(index: number): Promise<PacketLocation | null> {
		if (this.canUseIndex() && index < this.info.editUnitCount) {
			let pending = this.indexedPackets.get(index);
			if (!pending) {
				const lookup = this.demuxer.indexedPacket(
					index, this.info, this.hasTemporalIndex(),
				);
				pending = lookup.then(async (klv) => {
					if (!klv) {
						return null;
					}
					const location = await this.indexedLocation(klv, index);
					location.prefetchEnd = klv.prefetchEnd;
					if (this.hasTemporalIndex()) {
						const timing = await this.demuxer.resolveDecode(index, this.info);
						const { numerator, denominator } = this.info.rate;
						location.timestamp = timing.presentation * denominator / numerator;
						location.isKey = timing.isKey;
						location.requiresParameters = timing.requiresParameters;
						const delay = this.info.hevcSubDescriptor?.properties.get(P.hevcDecodingDelay);
						requireMxf(!delay || uint(delay, 1) !== 0 || timing.presentation === index,
							'HEVC zero decoding delay contradicts temporal reordering');
					}
					if (index === this.info.editUnitCount - 1) {
						this.indexedEnd = true;
					}
					return location;
				});
				// Bound sparse random-access state independently of the sequential scan's exact packet list.
				if (this.indexedPackets.size >= 256) {
					this.indexedPackets.delete(this.indexedPackets.keys().next().value!);
				}
				this.indexedPackets.set(index, pending);
			}
			return pending;
		}
		return null;
	}

	async location(index: number): Promise<PacketLocation | null> {
		if (this.requiresIndex() && index >= this.info.editUnitCount) {
			return null;
		}
		const location = await this.indexed(index);
		if (location) {
			return location;
		}
		requireMxf(!this.requiresIndex(), this.info.avci
			? 'AVC-Intra requires a supported index; scanning cannot recover random access'
			: 'AVC/HEVC requires a supported temporal index; scanning cannot recover timing');
		await this.demuxer.scanUntil(() => this.info.packets.length > index);
		return this.info.packets[index] ?? null;
	}

	getFirstPacket(options: PacketRetrievalOptions) {
		return this.packet(0, options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		if (timestamp < 0) {
			return null;
		}
		if (this.requiresIndex() && this.info.editUnitCount === 0) {
			return null;
		}
		if (this.canUseIndex() && this.info.editUnitCount > 0) {
			const { numerator, denominator } = this.info.rate;
			let index = Math.min(this.info.editUnitCount - 1, Math.floor(timestamp * numerator / denominator));
			if (index * denominator / numerator > timestamp) {
				index--;
			}
			if (index + 1 < this.info.editUnitCount && (index + 1) * denominator / numerator <= timestamp) {
				index++;
			}
			if (this.hasTemporalIndex()) {
				return this.packet(await this.demuxer.resolvePresentation(index, this.info), options);
			}
			if (await this.indexed(index)) {
				return this.packet(index, options);
			}
		}
		requireMxf(!this.requiresIndex(), 'AVC/HEVC requires a supported index; scanning cannot recover random access');
		await this.demuxer.scanUntil(() => {
			const last = this.info.packets.at(-1);
			return !!last && last.timestamp > timestamp;
		});
		let low = 0;
		let high = this.info.packets.length;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (this.info.packets[mid]!.timestamp <= timestamp) {
				low = mid + 1;
			} else {
				high = mid;
			}
		}
		return this.packet(low - 1, options);
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const index = this.packetIndices.get(packet);
		if (index === undefined) {
			throw new Error('Packet does not belong to this track.');
		}
		return this.packet(index + 1, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}

class MxfD10VideoTrackBacking extends MxfTrackBacking implements InputVideoTrackBacking {
	private height: number;
	private displayHeight: number;
	private squareWidth: number;
	private pictureSize: number;

	constructor(demuxer: MxfDemuxer, info: TrackInfo) {
		super(demuxer, info);
		const d = info.descriptor;
		const variant = d10Variant(hex(property(d, P.container)));
		const pal = variant % 2 === 1;
		requireMxf(!info.opAtom && d.kind === 0x28
			&& hex(property(d, P.pictureCoding)) === `060e2b3404010101040102020102010${variant}`
			&& (info.trackNumber >>> 8) === 0x050101, 'unsupported D-10 picture coding or essence key');
		requireMxf(equalRationals(info.rate, { numerator: pal ? 25 : 30000, denominator: pal ? 1 : 1001 })
			&& equalRationals(rational(property(d, P.sampleRate)), info.rate), 'D-10 picture rate mismatch');
		const storedHeight = pal ? 304 : 256;
		const displayHeight = pal ? 288 : 243;
		for (const [key, value, size] of [[P.layout, 1, 1], [P.fieldDominance, 1, 1],
			[P.width, 720, 4], [P.height, storedHeight, 4], [P.sampledWidth, 720, 4],
			[P.sampledHeight, storedHeight, 4], [P.sampledX, 0, 4], [P.sampledY, 0, 4],
			[P.displayWidth, 720, 4], [P.displayHeight, displayHeight, 4], [P.displayX, 0, 4],
			[P.displayY, pal ? 16 : 13, 4], [P.storedF2Offset, 0, 4], [P.displayF2Offset, 0, 4]] as const) {
			requireMxf(uint(property(d, key), size) === value, 'unsupported D-10 separate-field geometry');
		}
		const lines = batch(property(d, P.videoLineMap), 4).map(x => uint(x, 4));
		requireMxf(lines.length === 2 && lines[0] === 7 && lines[1] === (pal ? 320 : 270),
			'unsupported D-10 video line map');
		this.height = 2 * storedHeight;
		this.displayHeight = 2 * displayHeight;
		const aspect = rational(property(d, P.aspect));
		this.squareWidth = this.displayHeight * aspect.numerator / aspect.denominator;
		this.pictureSize = [250000, 208541, 200000, 166833, 150000, 125125][variant - 1]!;
	}

	getType() {
		return 'video' as const;
	}

	getCodec() {
		return null;
	}

	async getDecoderConfig() {
		return null;
	}

	getInternalCodecId() {
		return property(this.info.descriptor, P.pictureCoding).slice();
	}

	getCodedWidth() {
		return 720;
	}

	getCodedHeight() {
		return this.height;
	}

	getSquarePixelWidth() {
		return this.squareWidth;
	}

	getSquarePixelHeight() {
		return this.height;
	}

	getMetadataDisplayWidth() {
		return this.squareWidth;
	}

	getMetadataDisplayHeight() {
		return this.displayHeight;
	}

	getTransformationMatrix() {
		return IDENTITY_MATRIX;
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return {};
	}

	async canBeTransparent() {
		return false;
	}

	append(klv: Klv) {
		this.info.packets.push(this.indexedLocation(klv, this.info.packets.length));
	}

	indexedLocation(klv: Klv, index: number): PacketLocation {
		requireMxf(klv.size === this.pictureSize, 'D-10 picture size disagrees with defined template');
		return { offset: klv.offset, size: klv.size,
			timestamp: index * this.info.rate.denominator / this.info.rate.numerator,
			duration: this.info.rate.denominator / this.info.rate.numerator };
	}
}

class MxfVideoTrackBacking extends MxfTrackBacking implements InputVideoTrackBacking {
	private width: number;
	private height: number;
	private squareWidth: number;
	private codec: string;
	private nalCodec: 'avc' | 'hevc' | null;
	private nalProfile = 0;
	private avciFormat: AvciFormat | undefined;
	private nalConfig: Promise<VideoDecoderConfig> | null = null;
	private nalParameters: string | null = null;
	private hevcLengthSize: number | null = null;
	private headerPromise: Promise<VideoColorSpaceInit> | null = null;
	constructor(demuxer: MxfDemuxer, info: TrackInfo) {
		super(demuxer, info);
		const d = info.descriptor;
		const container = hex(property(d, P.container));
		const coding = hex(property(d, P.pictureCoding, 16));
		// Doremi LibMedia leaves PictureEssenceCoding zero and mislabels Codec as High 10 Intra.
		// This exact legacy descriptor is checked against the actual Main-profile SPS below.
		info.legacyAvc = info.opAtom && d.kind === 0x51 && container === LEGACY_AVC_CONTAINER
			&& coding === '00000000000000000000000000000000'
			&& hex(d.properties.get(P.codec) ?? new Uint8Array()) === '060e2b340401010a0401020201322001';
		this.nalCodec = container === HEVC_CONTAINER
			? 'hevc'
			: container === AVC_CONTAINER || info.legacyAvc ? 'avc' : null;
		requireMxf(this.nalCodec === 'avc'
			? [0x28, 0x51].includes(d.kind)
			: d.kind === 0x28 && (this.nalCodec === 'hevc' || container === PRORES_CONTAINER),
		'unsupported picture descriptor or frame wrapping');
		const profile = Number.parseInt(coding.slice(28, 30), 16);
		const avci = this.avciFormat = this.nalCodec === 'avc' ? AVCI_FORMATS[coding.slice(16)] : undefined;
		info.avci = !!avci;
		if (this.nalCodec) {
			const profiles = this.nalCodec === 'avc' ? AVC_PROFILES : HEVC_PROFILES;
			this.nalProfile = info.legacyAvc ? 77 : avci?.profile ?? profiles[coding.slice(16)] ?? 0;
			requireMxf(info.legacyAvc || (coding.startsWith('060e2b34040101')
				&& this.nalProfile !== 0),
			`unsupported ${this.nalCodec.toUpperCase()} picture coding`);
			requireMxf(info.indexSid !== 0, avci
				? 'AVC-Intra requires an index'
				: `${this.nalCodec.toUpperCase()} requires a temporal index`);
			requireMxf(this.nalCodec !== 'hevc' || !info.opAtom, 'HEVC OPAtom is not supported');
			requireMxf(!avci || !info.opAtom, 'AVC-Intra OPAtom is not supported');
			this.codec = this.nalCodec;
		} else {
			requireMxf(coding.startsWith('060e2b340401010d040102020306') && coding.endsWith('00')
				&& profile >= 1 && profile <= 6, 'unsupported ProRes profile');
			this.codec = PROFILES[profile - 1]!;
		}
		requireMxf(uint(property(d, P.layout), 1) === 0, 'interlaced or segmented-frame picture');
		const rate = rational(property(d, P.sampleRate));
		requireMxf(equalRationals(rate, info.rate), 'picture rate mismatch');
		const number = info.trackNumber;
		requireMxf((number >>> 24) === 0x15
			&& ((number >>> 8) & 255) === (this.nalCodec ? 0x05 : 0x17),
		'unsupported picture essence key');
		this.width = uint(property(d, P.width), 4);
		this.height = uint(property(d, P.height), 4);
		requireMxf(this.width > 0 && this.height > 0, 'empty picture');
		let sampledWidth = this.width;
		let sampledHeight = this.height;
		if (this.nalCodec) {
			const sampledWidthProperty = d.properties.get(P.sampledWidth);
			const sampledHeightProperty = d.properties.get(P.sampledHeight);
			sampledWidth = sampledWidthProperty ? uint(sampledWidthProperty, 4) : this.width;
			sampledHeight = sampledHeightProperty ? uint(sampledHeightProperty, 4) : this.height;
			requireMxf(sampledWidth > 0 && sampledWidth <= this.width
				&& sampledHeight > 0 && sampledHeight <= this.height, 'AVC/HEVC sampled raster exceeds stored picture');
			for (const key of [P.sampledX, P.sampledY]) {
				const value = d.properties.get(key);
				requireMxf(!value || uint(value, 4) === 0, 'cropped picture is not supported');
			}
			const displayWidth = d.properties.get(P.displayWidth);
			const displayHeight = d.properties.get(P.displayHeight);
			const width = displayWidth ? uint(displayWidth, 4) : sampledWidth;
			const height = displayHeight ? uint(displayHeight, 4) : sampledHeight;
			requireMxf(width > 0 && width <= sampledWidth && height > 0 && height <= sampledHeight,
				'AVC/HEVC display rectangle exceeds sampled raster');
			this.width = width;
			this.height = height;
		}
		for (const [key, expected] of [[P.displayWidth, this.width], [P.displayHeight, this.height],
			[P.displayX, 0], [P.displayY, 0]] as const) {
			const value = d.properties.get(key);
			requireMxf(!value || uint(value, 4) === expected, 'cropped picture is not supported');
		}
		const aspect = rational(property(d, P.aspect));
		this.squareWidth = this.height * aspect.numerator / aspect.denominator;
		if (avci) {
			requireMxf(avci.rates.some(numerator => equalRationals(info.rate,
				{ numerator, denominator: avci.denominator })),
			'AVC-Intra coding label disagrees with edit rate');
			const class50 = avci.profile === 110;
			const fullWidth = avci.height === 720 ? 1280 : 1920;
			requireMxf((this.width === avci.width || (class50 && this.width === fullWidth))
				&& this.height === avci.height && uint(property(d, P.width), 4) === this.width
				&& [avci.height, avci.height === 1080 ? 1088 : 720].includes(uint(property(d, P.height), 4)),
			'AVC-Intra coding label disagrees with descriptor raster');
			if (class50) {
				requireMxf(equalRationals(aspect, { numerator: 16, denominator: 9 }),
					'AVC-Intra50 requires a 16:9 descriptor aspect ratio');
				requireMxf(sampledWidth === this.width
					&& [avci.height, avci.height === 1080 ? 1088 : 720].includes(sampledHeight),
				'AVC-Intra50 has incoherent descriptor raster');
				// Class 50 descriptors use either subsampled widths or full 1920/1280 presentation widths.
				// Both describe the same 1440/960-wide coded pictures, checked against the in-band SPS below.
				this.width = avci.width;
			}
		}
	}

	getType() {
		return 'video' as const;
	}

	getCodec() {
		return this.nalCodec ?? 'prores' as const;
	}

	override getHasOnlyKeyPackets() {
		return !this.hasTemporalIndex();
	}

	getInternalCodecId() {
		return property(this.info.descriptor, P.pictureCoding).slice();
	}

	getCodedWidth() {
		return this.width;
	}

	getCodedHeight() {
		return this.height;
	}

	getSquarePixelWidth() {
		return this.squareWidth;
	}

	getSquarePixelHeight() {
		return this.height;
	}

	getTransformationMatrix() {
		return IDENTITY_MATRIX;
	}

	async canBeTransparent() {
		return this.codec === 'ap4h' || this.codec === 'ap4x';
	}

	append(klv: Klv) {
		this.info.packets.push(this.indexedLocation(klv, this.info.packets.length));
	}

	indexedLocation(klv: Klv, index: number) {
		requireMxf(klv.size >= (this.nalCodec ? 5 : 36), 'truncated picture frame');
		if (this.avciFormat) {
			requireMxf(klv.lengthSize === 4 && klv.size === this.avciFormat.size,
				'AVC-Intra requires complete fixed-size access units with four-byte BER lengths');
		}
		if (this.nalCodec === 'hevc') {
			requireMxf([4, 5].includes(klv.lengthSize)
				&& (this.hevcLengthSize === null || this.hevcLengthSize === klv.lengthSize),
			'HEVC frame wrapping requires constant four- or five-byte BER lengths');
			this.hevcLengthSize = klv.lengthSize;
		}
		const duration = this.info.rate.denominator / this.info.rate.numerator;
		return { offset: klv.offset, size: klv.size,
			timestamp: index * this.info.rate.denominator / this.info.rate.numerator, duration,
			isKey: this.info.avci ? true : undefined };
	}

	protected override async readPacket(packet: PacketLocation, index: number) {
		const data = await super.readPacket(packet, index);
		if (this.nalCodec === 'avc' && !packet.isKey) {
			if (this.info.legacyAvc && packet.requiresParameters) {
				const record = extractAvcDecoderConfigurationRecord(data);
				await this.getDecoderConfig();
				requireMxf(record && avcParameterSets(record) === this.nalParameters,
					'AVC requires stable parameter sets, repeated together');
			} else {
				const parameters = [...iterateNalUnitsInAnnexB(data)]
					.filter(nal => [7, 8].includes(extractNalUnitTypeForAvc(data[nal.offset]!)));
				if (parameters.length) {
					await this.getDecoderConfig();
					const stored = this.nalParameters!.split(':');
					requireMxf(parameters.every(nal =>
						stored.includes(hex(data.subarray(nal.offset, nal.offset + nal.length)))),
					'AVC requires stable parameter sets');
				}
			}
		}
		if (this.nalCodec === 'avc' && packet.isKey) {
			const record = extractAvcDecoderConfigurationRecord(data);
			requireMxf(record, 'AVC key access unit requires in-band SPS/PPS');
			const types = [...iterateNalUnitsInAnnexB(data)].map(nal => extractNalUnitTypeForAvc(data[nal.offset]!));
			requireMxf(types.includes(5), 'AVC key access unit must contain IDR');
			requireMxf(!this.info.avci || types.every(type => ![1, 2, 3, 4, 19, 20, 21].includes(type)),
				'AVC-Intra requires IDR slices in every access unit');
			await this.getDecoderConfig();
			requireMxf(avcParameterSets(record) === this.nalParameters,
				'AVC key access unit changes SPS/PPS; stable parameter sets are required');
		}
		if (this.nalCodec === 'hevc') {
			const unit = this.hevcAccessUnit(data, packet.timestamp === 0);
			requireMxf(unit.isIdr === packet.isKey, 'HEVC payload disagrees with indexed IDR_N_LP access point');
			requireMxf(!packet.isKey || unit.parameters, 'HEVC key access unit requires in-band VPS/SPS/PPS');
			if (unit.parameters) {
				await this.getDecoderConfig();
				requireMxf(unit.parameters === this.nalParameters, 'HEVC requires stable VPS/SPS/PPS parameter sets');
			}
		}
		return data;
	}

	getColorSpace(): Promise<VideoColorSpaceInit> {
		if (this.nalCodec) {
			return this.getDecoderConfig().then(config => config.colorSpace!);
		}
		return this.headerPromise ??= (async () => {
			const first = await this.location(0);
			requireMxf(first && first.size >= 36, 'missing ProRes frame');
			const bytes = await this.demuxer.bytes(first.offset, 36);
			const header = extractProresCodecInfoFromPacket(bytes);
			requireMxf(header && uint(bytes.subarray(0, 4), 4) === first.size
				&& uint(bytes.subarray(8, 10), 2) + 8 <= first.size, 'invalid ProRes frame header');
			requireMxf(uint(bytes.subarray(16, 18), 2) === this.width
				&& uint(bytes.subarray(18, 20), 2) === this.height && ((bytes[20]! >> 2) & 3) === 0,
			'ProRes geometry or progressive layout mismatch');
			return {
				primaries: COLOR_PRIMARIES_MAP_INVERSE[header.colourPrimaries],
				transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[header.transferCharacteristics],
				matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[header.matrixCoefficients], fullRange: false,
			} as VideoColorSpaceInit;
		})();
	}

	private hevcAccessUnit(data: Uint8Array, first: boolean) {
		const nals = [...iterateNalUnitsInAnnexB(data)].map(loc => data.subarray(loc.offset, loc.offset + loc.length));
		for (const nal of nals) {
			requireMxf(nal.length >= 2 && (nal[0]! & 0x81) === 0 && (nal[1]! & 0xf8) === 0
				&& (nal[1]! & 7) !== 0, 'HEVC requires single-layer NAL units with valid headers');
		}
		const types = nals.map(nal => extractNalUnitTypeForHevc(nal[0]!));
		const vcl = types.filter(type => type < 32);
		requireMxf(vcl.length && vcl.every(type => type <= 5 || type === HevcNalUnitType.IDR_N_LP),
			'HEVC supports IDR_N_LP closed GOPs without leading pictures; other restart types are unsupported');
		const isIdr = vcl.includes(HevcNalUnitType.IDR_N_LP);
		requireMxf(!isIdr || vcl.every(type => type === HevcNalUnitType.IDR_N_LP), 'mixed HEVC picture NAL types');
		const parameters = nals.filter((_, i) => types[i]! >= HevcNalUnitType.VPS_NUT
			&& types[i]! <= HevcNalUnitType.PPS_NUT);
		requireMxf(!parameters.length || (parameters.length === 3
			&& [HevcNalUnitType.VPS_NUT, HevcNalUnitType.SPS_NUT, HevcNalUnitType.PPS_NUT]
				.every(type => types.includes(type))), 'HEVC requires VPS/SPS/PPS repeated together');
		for (const key of [P.hevcVpsFlag, P.hevcSpsFlag, P.hevcPpsFlag]) {
			const flag = this.info.hevcSubDescriptor?.properties.get(key);
			if (flag) {
				const location = (uint(flag, 1) >> 4) & 7;
				requireMxf((location !== 1 || first || !parameters.length)
					&& (location !== 2 || parameters.length === 3),
				'HEVC parameter-set presence disagrees with subdescriptor');
			}
		}
		return { isIdr, parameters: parameters.length ? parameters.map(hex).sort().join(':') : null };
	}

	private hevcDecoderConfig(data: Uint8Array): VideoDecoderConfig {
		const unit = this.hevcAccessUnit(data, true);
		requireMxf(unit.isIdr && unit.parameters, 'HEVC must start with IDR_N_LP and in-band VPS/SPS/PPS');
		const record = extractHevcDecoderConfigurationRecord(data);
		requireMxf(record, 'invalid HEVC decoder parameter sets');
		const sps = parseHevcSps(record.arrays.find(x => x.nalUnitType === HevcNalUnitType.SPS_NUT)!.nalUnits[0]!)!;
		const main42210 = this.nalProfile === 4;
		const c = sps.generalConstraintIndicatorFlags;
		requireMxf(sps.generalProfileSpace === 0 && (sps.generalProfileIdc === this.nalProfile
			|| (main42210 && (sps.generalProfileCompatibilityFlags & 0x08000000) !== 0)),
		'HEVC SPS profile disagrees with picture coding');
		// H.265 Table A.2 distinguishes Main 4:2:2 10 from the other profile-4 formats.
		requireMxf(!main42210 || ((c[0]! & 0x0f) === 0x0d && (c[1]! & 0xf8) === 0x08),
			'HEVC requires Main 4:2:2 10 profile constraints');
		requireMxf(sps.fieldSeqFlag === 0 && !(c[0]! & 0x40)
			&& sps.chromaFormatIdc === (main42210 ? 2 : 1)
			&& sps.bitDepthChromaMinus8 === sps.bitDepthLumaMinus8
			&& (main42210
				? sps.bitDepthLumaMinus8 === 2
				: this.nalProfile === 1 ? sps.bitDepthLumaMinus8 === 0 : [0, 2].includes(sps.bitDepthLumaMinus8)),
		'HEVC requires progressive Main 8-bit, Main10 8/10-bit 4:2:0 or Main 4:2:2 10-bit');
		requireMxf(sps.displayWidth === this.width && sps.displayHeight === this.height,
			'HEVC SPS geometry disagrees with descriptor');
		const aspect = rational(property(this.info.descriptor, P.aspect));
		requireMxf(!sps.pixelAspectRatioSpecified || (sps.pixelAspectRatio.num > 0 && sps.pixelAspectRatio.den > 0
			&& equalRationals({ numerator: this.width * sps.pixelAspectRatio.num,
				denominator: this.height * sps.pixelAspectRatio.den },
			aspect)),
		'HEVC SPS aspect ratio disagrees with descriptor');
		for (const [key, expected] of [[P.componentDepth, sps.bitDepthLumaMinus8 + 8],
			[P.horizontalSubsampling, 2], [P.verticalSubsampling, main42210 ? 1 : 2]] as const) {
			const value = this.info.descriptor.properties.get(key);
			requireMxf(!value || uint(value, 4) === expected, 'HEVC SPS disagrees with CDCI depth or subsampling');
		}
		const descriptor = this.info.hevcSubDescriptor;
		if (descriptor) {
			uint(property(descriptor, P.hevcDecodingDelay), 1);
			// ST 381-5 Table 7. H.265 7.3.3 only includes max_14bit for profiles 5, 9, 10 and 11.
			const max14Present = [5, 9, 10, 11].some(profile => sps.generalProfileIdc === profile
				|| (sps.generalProfileCompatibilityFlags & (0x80000000 >>> profile)) !== 0);
			const main10 = sps.generalProfileIdc === 2 || (sps.generalProfileCompatibilityFlags & 0x20000000) !== 0;
			const constraints = main42210
				? ((c[0]! & 0x3f) << 10) | ((c[1]! & 0xf8) << 2) | (max14Present ? (c[1]! & 4) << 2 : 0)
				: ((c[0]! & 0x30) << 10) | (main10 ? (c[1]! & 0x10) << 2 : 0);
			for (const [key, expected, size] of [[P.hevcProfile, sps.generalProfileIdc, 1],
				[P.hevcProfileConstraint, constraints, 2], [P.hevcTier, sps.generalTierFlag, 1],
				[P.hevcLevel, sps.generalLevelIdc, 1]] as const) {
				const value = descriptor.properties.get(key);
				requireMxf(!value || uint(value, size) === expected, 'HEVC subdescriptor disagrees with SPS');
			}
			const kind = descriptor.properties.get(P.hevcCodedContentKind);
			requireMxf(!kind || [0, 1].includes(uint(kind, 1)), 'HEVC subdescriptor must not declare field pictures');
			const closed = descriptor.properties.get(P.hevcClosedGop);
			requireMxf(!closed || uint(closed, 1) <= 1, 'invalid HEVC closed GOP indicator');
			for (const key of [P.hevcVpsFlag, P.hevcSpsFlag, P.hevcPpsFlag]) {
				const value = descriptor.properties.get(key);
				requireMxf(!value || ((uint(value, 1) & 0x7f) <= 0x30 && (value[0]! & 0x0f) === 0),
					'unsupported HEVC parameter-set flags');
			}
		}
		this.nalParameters = unit.parameters;
		return {
			codec: extractVideoCodecString({ codec: 'hevc', width: this.width, height: this.height,
				codecDescription: null, colorSpace: null, avcType: null, avcCodecInfo: null,
				hevcCodecInfo: record, vp9CodecInfo: null, av1CodecInfo: null, proresFormat: null }),
			codedWidth: this.width, codedHeight: this.height,
			displayAspectWidth: aspect.numerator, displayAspectHeight: aspect.denominator,
			colorSpace: {
				primaries: COLOR_PRIMARIES_MAP_INVERSE[sps.colourPrimaries],
				transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[sps.transferCharacteristics],
				matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[sps.matrixCoefficients], fullRange: !!sps.fullRangeFlag,
			} as VideoColorSpaceInit,
		};
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig> {
		if (this.nalCodec) {
			return this.nalConfig ??= (async () => {
				const first = await this.location(0);
				requireMxf(first && first.isKey, 'AVC/HEVC must start with IDR');
				const data = await this.demuxer.bytes(first.offset, first.size);
				if (this.nalCodec === 'hevc') {
					return this.hevcDecoderConfig(data);
				}
				const record = extractAvcDecoderConfigurationRecord(data);
				requireMxf(record && record.sequenceParameterSets.length === 1,
					'AVC first access unit requires SPS/PPS');
				const sps = parseAvcSps(record.sequenceParameterSets[0]!)!;
				requireMxf(sps.profileIdc === this.nalProfile, this.info.legacyAvc
					? 'legacy OPAtom requires AVC Main profile'
					: 'AVC SPS profile disagrees with picture coding');
				const high422 = this.nalProfile === 122;
				const high10 = this.nalProfile === 110;
				requireMxf(!high10 || (sps.constraintFlags & 0xe7) === 0,
					'AVC High 10 has invalid profile constraints');
				requireMxf(!high10 || !(sps.constraintFlags & 0x10) || sps.maxNumRefFrames === 0,
					'AVC High 10 Intra forbids reference frames');
				requireMxf(![100, 110, 122].includes(this.nalProfile) || !sps.qpprimeYZeroTransformBypassFlag,
					'AVC profile forbids transform bypass');
				if (this.avciFormat) {
					const highRate = this.info.rate.numerator > 30 * this.info.rate.denominator;
					requireMxf((sps.constraintFlags & 0x10) !== 0 && sps.bitDepthLumaMinus8 === 2
						&& sps.levelIdc === (this.height === 1080 && highRate ? 42 : this.avciFormat.baseLevel),
					'AVC-Intra requires High 10 or High 4:2:2 Intra 10-bit at the prescribed level');
				}
				requireMxf(sps.frameMbsOnlyFlag === 1 && sps.chromaFormatIdc === (high422 ? 2 : 1)
					&& (high422 || high10 ? [0, 2].includes(sps.bitDepthLumaMinus8) : sps.bitDepthLumaMinus8 === 0)
					&& sps.bitDepthChromaMinus8 === sps.bitDepthLumaMinus8,
				high422
					? 'AVC High 4:2:2 requires progressive 8-bit or 10-bit 4:2:2'
					: high10
						? 'AVC High 10 requires progressive 8-bit or 10-bit 4:2:0'
						: 'AVC requires progressive 8-bit 4:2:0');
				for (const [key, expected] of [[P.componentDepth, sps.bitDepthLumaMinus8 + 8],
					[P.horizontalSubsampling, 2], [P.verticalSubsampling, high422 ? 1 : 2]] as const) {
					const value = this.info.descriptor.properties.get(key);
					requireMxf(!value || uint(value, 4) === expected,
						'AVC SPS disagrees with CDCI depth or subsampling');
				}
				requireMxf(sps.displayWidth === this.width && sps.displayHeight === this.height,
					'AVC SPS geometry disagrees with descriptor');
				requireMxf(!this.avciFormat || !high10 || (sps.codedWidth === this.width
					&& sps.codedHeight === (this.height === 1080 ? 1088 : 720) && sps.frameCropTopOffset === 0),
				'AVC-Intra50 SPS coded raster or cropping disagrees with the coding label');
				const aspect = rational(property(this.info.descriptor, P.aspect));
				requireMxf(!high10 || !sps.pixelAspectRatioSpecified
					|| (sps.pixelAspectRatio.num > 0 && sps.pixelAspectRatio.den > 0
						&& equalRationals({ numerator: this.width * sps.pixelAspectRatio.num,
							denominator: this.height * sps.pixelAspectRatio.den }, aspect)),
				'AVC SPS aspect ratio disagrees with descriptor');
				const nalTypes = [...iterateNalUnitsInAnnexB(data)]
					.map(nal => extractNalUnitTypeForAvc(data[nal.offset]!));
				requireMxf(nalTypes.includes(5), 'AVC first access unit must contain IDR');
				requireMxf(!this.info.avci || nalTypes.every(type => ![1, 2, 3, 4, 19, 20, 21].includes(type)),
					'AVC-Intra requires IDR slices in every access unit');
				this.nalParameters = avcParameterSets(record);
				return {
					codec: `avc1.${[record.avcProfileIndication, record.profileCompatibility, record.avcLevelIndication]
						.map(value => value.toString(16).padStart(2, '0')).join('')}`,
					codedWidth: this.width, codedHeight: this.height,
					...(high10
						? { displayAspectWidth: aspect.numerator, displayAspectHeight: aspect.denominator }
						: {}),
					colorSpace: {
						primaries: COLOR_PRIMARIES_MAP_INVERSE[sps.colourPrimaries],
						transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[sps.transferCharacteristics],
						matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[sps.matrixCoefficients], fullRange: !!sps.fullRangeFlag,
					} as VideoColorSpaceInit,
				};
			})();
		}
		return {
			codec: this.codec, codedWidth: this.width, codedHeight: this.height, colorSpace: await this.getColorSpace(),
		};
	}

	override async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		if (!this.hasTemporalIndex()) {
			return super.getKeyPacket(timestamp, options);
		}
		let packet = await this.getPacket(timestamp, { ...options, metadataOnly: true });
		while (packet) {
			const timing = await this.demuxer.resolveDecode(packet.sequenceNumber, this.info);
			const key = await this.packet(timing.key, options);
			if (!key || key.timestamp <= timestamp) {
				return key;
			}
			if (timing.key === 0) {
				return null;
			}
			packet = await this.packet(timing.key - 1, { ...options, metadataOnly: true });
		}
		return null;
	}

	override async getNextKeyPacket(
		packet: EncodedPacket, options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		if (!this.hasTemporalIndex()) {
			return super.getNextKeyPacket(packet, options);
		}
		const index = this.packetIndices.get(packet);
		if (index === undefined) {
			throw new Error('Packet does not belong to this track.');
		}
		if (this.info.legacyAvc) {
			return null;
		}
		for (let i = index + 1; i < this.info.editUnitCount; i++) {
			const timing = await this.demuxer.resolveDecode(i, this.info);
			if (timing.isKey) {
				return this.packet(i, options);
			}
		}
		return null;
	}
}

class MxfAudioTrackBacking extends MxfTrackBacking implements InputAudioTrackBacking {
	private channels: number;
	private sampleRate: number;
	private blockAlign: number;
	private codec: AudioCodec;
	private st331: boolean;
	constructor(demuxer: MxfDemuxer, info: TrackInfo) {
		super(demuxer, info);
		const d = info.descriptor;
		const container = hex(property(d, P.container, 16));
		const variant = d10Variant(container);
		this.st331 = variant !== 0;
		requireMxf((d.kind === 0x47 && container === AES_CONTAINER)
			|| (d.kind === 0x48 && container === WAVE_CONTAINER)
			|| (this.st331 && [0x42, 0x47].includes(d.kind)),
		'packed frame-wrapped PCM required');
		const coding = d.properties.get(P.soundCoding);
		const codingUl = coding ? hex(coding) : null;
		// ST 377-1 Annex F.5 defaults an absent SoundEssenceCoding to uncompressed sound.
		requireMxf(codingUl === null || (container === WAVE_CONTAINER
			? ['060e2b34040101010402020101000000', '060e2b3404010101040202017f000000'].includes(codingUl)
			: /^060e2b34040101[0-9a-f]{2}04020201(01|7f)000000$/.test(codingUl)),
		'unsupported sound coding');
		const elementType = d.kind === 0x47 ? 0x03 : 0x01;
		requireMxf(this.st331
			? (info.trackNumber >>> 8) === 0x060110
			: (info.trackNumber >>> 24) === 0x16 && ((info.trackNumber >>> 8) & 255) === elementType,
		'PCM essence key');
		const rate = rational(property(d, P.audioRate));
		this.sampleRate = rate.numerator / rate.denominator;
		requireMxf(Number.isInteger(this.sampleRate), 'fractional audio sample rate');
		const descriptorRate = rational(property(d, P.sampleRate));
		requireMxf(equalRationals(descriptorRate, rate) || equalRationals(descriptorRate, info.rate),
			'PCM descriptor sample rate');
		this.channels = uint(property(d, P.channels), 4);
		const bits = uint(property(d, P.bits), 4);
		this.blockAlign = this.st331 ? this.channels * bits / 8 : uint(property(d, P.blockAlign), 2);
		requireMxf(this.channels > 0 && [16, 24, 32].includes(bits)
			&& this.blockAlign === this.channels * bits / 8, 'unsupported PCM packing');
		if (this.st331) {
			requireMxf(!info.opAtom && [4, 8].includes(this.channels) && [16, 24].includes(bits)
				&& this.sampleRate === 48000 && uint(property(d, P.locked), 1) === 1
				&& equalRationals(info.rate, { numerator: variant % 2 ? 25 : 30000,
					denominator: variant % 2 ? 1 : 1001 }), 'unsupported D-10 AES3 audio format');
		}
		if (container !== WAVE_CONTAINER) {
			checkAes3ChannelStatus(d, this.channels);
		}
		this.codec = bits === 16 ? 'pcm-s16' : bits === 24 ? 'pcm-s24' : 'pcm-s32';
	}

	getType() {
		return 'audio' as const;
	}

	getCodec() {
		return this.codec;
	}

	getInternalCodecId() {
		return this.info.descriptor.properties.get(P.soundCoding)?.slice() ?? null;
	}

	getNumberOfChannels() {
		return this.channels;
	}

	getSampleRate() {
		return this.sampleRate;
	}

	override getTimeResolution() {
		return this.sampleRate;
	}

	override canUseIndex() {
		// ST 382 fixes the sample count for locked audio at integer samples per edit unit.
		const locked = this.info.descriptor.properties.get(P.locked);
		const samplesNumerator = this.sampleRate * this.info.rate.denominator;
		return super.canUseIndex()
			&& !!locked && uint(locked, 1) === 1
			&& Number.isSafeInteger(samplesNumerator) && samplesNumerator % this.info.rate.numerator === 0;
	}

	async indexedLocation(klv: Klv, index: number): Promise<PacketLocation> {
		const samples = this.sampleRate * this.info.rate.denominator / this.info.rate.numerator;
		const st331 = await this.readSt331Header(klv);
		requireMxf(st331 ? st331.samples === samples : klv.size === samples * this.blockAlign,
			'indexed PCM sample count does not match edit rate');
		requireMxf(Number.isSafeInteger(index * samples), 'PCM sample count overflow');
		return { offset: klv.offset, size: klv.size, timestamp: index * samples / this.sampleRate,
			duration: samples / this.sampleRate, st331, byteLength: samples * this.blockAlign };
	}

	async append(klv: Klv) {
		const st331 = await this.readSt331Header(klv);
		requireMxf(st331 || (klv.size > 0 && klv.size % this.blockAlign === 0), 'PCM payload block alignment');
		const samples = st331 ? st331.samples : klv.size / this.blockAlign;
		this.info.packets.push({ offset: klv.offset, size: klv.size,
			timestamp: this.info.sampleCount / this.sampleRate, duration: samples / this.sampleRate,
			st331, byteLength: samples * this.blockAlign });
		this.info.sampleCount += samples;
		requireMxf(Number.isSafeInteger(this.info.sampleCount), 'PCM sample count overflow');
	}

	private async readSt331Header(klv: Klv) {
		if (!this.st331) {
			return undefined;
		}
		requireMxf(klv.size >= 4, 'truncated ST 331 header');
		return parseSt331Header(await this.demuxer.bytes(klv.offset, 4), klv.size, this.channels,
			equalRationals(this.info.rate, { numerator: 25, denominator: 1 }));
	}

	protected override async readPacket(packet: PacketLocation, index: number) {
		const data = await super.readPacket(packet, index);
		if (!packet.st331) {
			return data;
		}
		const adjacent = async (neighbor: number, tail: boolean) => {
			if (neighbor < 0 || neighbor >= this.info.editUnitCount) {
				return undefined;
			}
			const location = await this.location(neighbor);
			requireMxf(location?.st331, 'missing adjacent ST 331 packet');
			const offset = tail ? location.offset + location.size - 96 : location.offset + 4;
			return { data: await this.demuxer.bytes(offset, 96), valid: location.st331.valid };
		};
		const [before, after] = await Promise.all([adjacent(index - 1, true), adjacent(index + 1, false)]);
		return unpackSt331({ data: data.subarray(4), valid: packet.st331.valid },
			this.channels, this.blockAlign / this.channels, before, after);
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		return { codec: this.codec, numberOfChannels: this.channels, sampleRate: this.sampleRate };
	}
}
