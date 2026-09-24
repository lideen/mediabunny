/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec } from '../codec';
import {
	AvcDecoderConfigurationRecord, extractAvcDecoderConfigurationRecord,
	extractNalUnitTypeForAvc, extractProresCodecInfoFromPacket,
	iterateNalUnitsInAnnexB, parseAvcSps,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { InputDisposedError } from '../input';
import { InputAudioTrackBacking, InputTrackBacking, InputVideoTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	COLOR_PRIMARIES_MAP_INVERSE, IDENTITY_MATRIX, MATRIX_COEFFICIENTS_MAP_INVERSE,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE, UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	batch, equalRationals, hex, MetadataSet, P, parseSet, position, property, rational, requireMxf, uint,
} from './mxf-metadata';
import { FILL_KEYS, INDEX_KEYS, MxfIndex, MxfKlv as Klv, PARTITION_PREFIX } from './mxf-index';

const PRIMER = '060e2b34020501010d01020101050100';
const SET_PREFIX = '060e2b34025301010d0101010101';
const ESSENCE_PREFIX = '060e2b34010201010d010301';
// SMPTE RDD 44 frame-wrapped ProRes mapping.
const PRORES_CONTAINER = '060e2b340401010d0d010301021c0100';
const HTJ2K_CONTAINER = '060e2b340401010d0d010301020c0600';
const AVC_CONTAINER = '060e2b340401010a0d01030102106001';
const LEGACY_AVC_CONTAINER = '060e2b34040101020d01030102106001';
// ST 382 AES/BWF carries packed little-endian samples, not ST 331 AES3 subframes.
const WAVE_CONTAINER = '060e2b34040101010d01030102060100';
const AES_CONTAINER = '060e2b34040101010d01030102060300';
const PICTURE = '060e2b34040101010103020201000000';
const SOUND = '060e2b34040101010103020202000000';
const TIMECODE = '060e2b34040101010103020101000000';
const PROFILES = ['apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x'];
const avcParameterSets = (record: AvcDecoderConfigurationRecord) => [
	...record.sequenceParameterSets, ...record.pictureParameterSets,
].map(hex).sort().join(':');

type PacketLocation = {
	offset: number; size: number; timestamp: number; duration: number; isKey?: boolean; prefetchEnd?: number;
	requiresParameters?: boolean;
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
	packets: PacketLocation[];
	sampleCount: number;
	legacyAvc: boolean;
	opAtom: boolean;
};

export class MxfDemuxer extends Demuxer {
	private metadataPromise: Promise<void> | null = null;
	private scanPromise: Promise<void> | null = null;
	private scanSignal?: AbortSignal;
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
		if (this.disposed) throw new InputDisposedError();
	}

	async bytes(offset: number, size: number, prefetchEnd = offset + size, requireFiniteRange = false,
		signal?: AbortSignal) {
		signal?.throwIfAborted();
		this.checkDisposed();
		requireMxf(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(size) && size >= 0
			&& Number.isSafeInteger(offset + size) && offset + size <= this.input._reader.fileSize!,
		'invalid byte range');
		const slice = await this.input._reader.source._read(
			offset, offset + size, offset, prefetchEnd, requireFiniteRange, signal,
		);
		signal?.throwIfAborted();
		this.checkDisposed();
		requireMxf(slice, 'truncated data');
		return slice.bytes.subarray(offset - slice.offset, offset - slice.offset + size);
	}

	async klv(offset: number, signal?: AbortSignal): Promise<Klv> {
		const header = await this.bytes(
			offset, Math.min(25, this.input._reader.fileSize! - offset), undefined, false, signal,
		);
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
		return { key: hex(header.subarray(0, 16)), offset: start, size, end };
	}

	async partition(klv: Klv, offset: number, signal?: AbortSignal) {
		requireMxf(klv.size >= 88 && klv.size <= 4096, 'partition pack size');
		const data = await this.bytes(klv.offset, klv.size, undefined, false, signal);
		requireMxf(uint(data.subarray(0, 2), 2) === 1, 'partition version');
		requireMxf(uint(data.subarray(8, 16), 8) === offset, 'partition offset');
		for (const start of [16, 24, 52]) uint(data.subarray(start, start + 8), 8);
		const op = hex(data.subarray(64, 80));
		const opAtom = op === '060e2b34040101010d01020110000000';
		requireMxf(opAtom || (op.startsWith('060e2b34040101010d0102010101') && op.endsWith('00')
			&& (data[78]! & 2) === 0), 'only self-contained OP1a or single-file OPAtom is supported');
		if (offset === 0) this.opAtom = opAtom;
		else requireMxf(opAtom === this.opAtom, 'partition operational pattern mismatch');
		const containers = batch(data.subarray(80), 16).map(hex);
		if (opAtom) {
			requireMxf((containers.length === 1 && containers[0] === AVC_CONTAINER)
				|| (containers.length === 2 && containers.includes(LEGACY_AVC_CONTAINER)
					&& containers.includes('060e2b34040101030d010301027f0100')),
			'unsupported OPAtom essence containers');
			if (offset === 0) this.essenceContainers = containers;
			else {
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

	async countedRegion(offset: number, size: number, kind: 'header' | 'index', signal?: AbortSignal) {
		if (size === 0) return { start: offset, end: offset };
		// Leading alignment Fill can only move the region's end later, so this window stays before essence.
		await this.bytes(offset, Math.min(size, 4096), undefined, false, signal);
		let first = await this.klv(offset, signal);
		while (FILL_KEYS.includes(first.key)) {
			offset = first.end;
			first = await this.klv(offset, signal);
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
				const set = parseSet(Number.parseInt(klv.key.slice(28, 30), 16),
					await this.bytes(klv.offset, klv.size), primer);
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
			this.tracks.push(definition === PICTURE
				? new MxfVideoTrackBacking(this, info)
				: new MxfAudioTrackBacking(this, info));
		}
		for (const track of sourceTracks) {
			const sequence = resolve(property(track, P.sequence));
			requireMxf(hex(property(sequence, P.definition)) === TIMECODE
				|| routes.has(uint(property(track, P.trackNumber), 4)), 'unmapped source track');
		}
		requireMxf(videos > 0 && descriptors.length === this.tracks.length, 'unmapped essence descriptor');
		requireMxf(!this.opAtom || (videos === 1 && audios === 0 && this.tracks[0]!.getCodec() === 'avc'),
			'OPAtom requires exactly one AVC video track');
	}

	private async scanOne(signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (this.scanOffset === this.input._reader.fileSize) {
			requireMxf(this.footerSeen, 'missing footer partition');
			for (const track of this.tracks) {
				if (track.getType() === 'video') {
					requireMxf(track.info.packets.length === track.info.editUnitCount,
						'picture edit-unit count does not match metadata');
				}
			}
			this.ended = true;
			return;
		}
		const offset = this.scanOffset;
		const klv = await this.klv(offset, signal);
		let next = klv.end;
		if (klv.key.startsWith(PARTITION_PREFIX) && ['03', '04'].includes(klv.key.slice(26, 28))) {
			requireMxf(!this.footerSeen, 'partition after footer');
			requireMxf(klv.key.endsWith('0400'), 'open or incomplete partition');
			const partition = await this.partition(klv, offset, signal);
			// Later partition metadata has its own primer and does not replace the closed header snapshot.
			const header = await this.countedRegion(next, partition.headerSize, 'header', signal);
			next = (await this.countedRegion(header.end, partition.indexSize, 'index', signal)).end;
			this.footerSeen = klv.key.slice(26, 28) === '04';
			this.bodySid = partition.bodySid;
		} else if (klv.key.startsWith(ESSENCE_PREFIX)) {
			requireMxf(!this.footerSeen, 'essence after footer');
			const trackNumber = Number.parseInt(klv.key.slice(24), 16);
			const track = this.tracks.find(x => x.info.bodySid === this.bodySid && x.info.trackNumber === trackNumber);
			requireMxf(track, 'unmapped essence element');
			track.append(klv);
		}
		this.scanOffset = next;
	}

	async scanUntil(done: () => boolean, signal?: AbortSignal) {
		signal?.throwIfAborted();
		await this.readMetadata();
		signal?.throwIfAborted();
		this.checkDisposed();
		while (!done() && !this.ended) {
			if (!this.scanPromise) {
				this.scanSignal = signal;
				this.scanPromise = this.scanOne(signal);
			}
			const pending = this.scanPromise;
			const owner = this.scanSignal;
			try {
				await pending;
			} catch (error) {
				if (!owner?.aborted) throw error;
			} finally {
				if (this.scanPromise === pending) this.scanPromise = null;
			}
			signal?.throwIfAborted();
		}
	}

	async indexedPacket(index: number, info: TrackInfo, temporal = false, signal?: AbortSignal) {
		signal?.throwIfAborted();
		await this.readMetadata();
		signal?.throwIfAborted();
		this.checkDisposed();
		return info.indexSid ? this.index!.locate(index, info, temporal, signal) : null;
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

	async getMimeType() { return 'application/mxf'; }
	async getMetadataTags(): Promise<MetadataTags> {
		await this.readMetadata();
		return this.metadataTags;
	}

	override dispose() { this.disposed = true; }
}

abstract class MxfTrackBacking implements InputTrackBacking {
	protected packetIndices = new WeakMap<EncodedPacket, number>();
	private indexedPackets = new Map<number, Promise<PacketLocation | null>>();
	private indexedEnd = false;

	constructor(public demuxer: MxfDemuxer, public info: TrackInfo) {}
	abstract getType(): 'video' | 'audio';
	abstract getCodec(): 'prores' | 'avc' | 'htj2k' | AudioCodec;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig>;
	abstract append(klv: Klv): void;
	abstract indexedLocation(klv: Klv, index: number): PacketLocation;
	canUseIndex() { return this.info.indexSid !== 0; }
	abstract getInternalCodecId(): Uint8Array | null;
	getId() { return this.info.id; }
	getNumber() { return this.info.number; }
	getName() { return null; }
	getLanguageCode() { return UNDETERMINED_LANGUAGE; }
	getTimeResolution() { return this.info.rate.numerator; }
	isRelativeToUnixEpoch() { return false; }
	getUnixTimeForTimestamp() { return null; }
	getDisposition() { return { ...DEFAULT_TRACK_DISPOSITION }; }
	getPairingMask() { return 1n; }
	getBitrate() { return null; }
	getAverageBitrate() { return null; }
	async getDurationFromMetadata() { return this.info.duration; }
	async getLiveRefreshInterval() { return null; }
	getHasOnlyKeyPackets() { return true; }
	protected readPacket(packet: PacketLocation) {
		// Only payload reads allow source-managed read-ahead, capped at the containing body partition.
		return this.demuxer.bytes(packet.offset, packet.size, packet.prefetchEnd);
	}

	async packet(index: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (index < 0) return null;
		if (index >= this.info.editUnitCount && this.indexedEnd) return null;
		const packet = await this.location(index, options._signal);
		this.demuxer.checkDisposed();
		if (!packet) return null;
		const data = options.metadataOnly ? PLACEHOLDER_DATA : await this.readPacket(packet);
		const result = new EncodedPacket(data, packet.isKey === false ? 'delta' : 'key',
			packet.timestamp, packet.duration, index, packet.size);
		this.demuxer.checkDisposed();
		this.packetIndices.set(result, index);
		return result;
	}

	private async indexed(index: number, signal?: AbortSignal): Promise<PacketLocation | null> {
		signal?.throwIfAborted();
		if (this.canUseIndex() && index < this.info.editUnitCount) {
			let pending = this.indexedPackets.get(index);
			if (!pending) {
				const lookup = this.demuxer.indexedPacket(index, this.info, this.getCodec() === 'avc', signal);
				pending = lookup.then(async (klv) => {
					signal?.throwIfAborted();
					if (!klv) return null;
					const location = this.indexedLocation(klv, index);
					location.prefetchEnd = klv.prefetchEnd;
					if (this.getCodec() === 'avc') {
						const timing = await this.demuxer.resolveDecode(index, this.info);
						const { numerator, denominator } = this.info.rate;
						location.timestamp = timing.presentation * denominator / numerator;
						location.isKey = timing.isKey;
						location.requiresParameters = timing.requiresParameters;
					}
					if (index === this.info.editUnitCount - 1) this.indexedEnd = true;
					return location;
				});
				// Bound sparse random-access state independently of the sequential scan's exact packet list.
				if (this.indexedPackets.size >= 256) {
					this.indexedPackets.delete(this.indexedPackets.keys().next().value!);
				}
				if (!signal) this.indexedPackets.set(index, pending);
			}
			const result = await pending;
			signal?.throwIfAborted();
			if (!this.indexedPackets.has(index) && this.indexedPackets.size >= 256) {
				this.indexedPackets.delete(this.indexedPackets.keys().next().value!);
			}
			this.indexedPackets.set(index, Promise.resolve(result));
			return result;
		}
		return null;
	}

	async location(index: number, signal?: AbortSignal): Promise<PacketLocation | null> {
		signal?.throwIfAborted();
		if (this.getCodec() === 'avc' && index >= this.info.editUnitCount) return null;
		const location = await this.indexed(index, signal);
		if (location) return location;
		requireMxf(this.getCodec() !== 'avc',
			'AVC requires a supported temporal index; scanning cannot recover timing');
		await this.demuxer.scanUntil(() => this.info.packets.length > index, signal);
		return this.info.packets[index] ?? null;
	}

	getFirstPacket(options: PacketRetrievalOptions) { return this.packet(0, options); }
	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		if (timestamp < 0) return null;
		if (this.getCodec() === 'avc' && this.info.editUnitCount === 0) return null;
		if (this.canUseIndex() && this.info.editUnitCount > 0) {
			const { numerator, denominator } = this.info.rate;
			let index = Math.min(this.info.editUnitCount - 1, Math.floor(timestamp * numerator / denominator));
			if (index * denominator / numerator > timestamp) index--;
			if (index + 1 < this.info.editUnitCount && (index + 1) * denominator / numerator <= timestamp) index++;
			if (this.getCodec() === 'avc') {
				return this.packet(await this.demuxer.resolvePresentation(index, this.info), options);
			}
			if (await this.indexed(index, options._signal)) return this.packet(index, options);
		}
		await this.demuxer.scanUntil(() => {
			const last = this.info.packets.at(-1);
			return !!last && last.timestamp > timestamp;
		}, options._signal);
		let low = 0;
		let high = this.info.packets.length;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (this.info.packets[mid]!.timestamp <= timestamp) low = mid + 1;
			else high = mid;
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

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) { return this.getPacket(timestamp, options); }
	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}

class MxfVideoTrackBacking extends MxfTrackBacking implements InputVideoTrackBacking {
	async getVideoDecodePacketReader(packet: EncodedPacket, signal?: AbortSignal) {
		signal?.throwIfAborted();
		this.demuxer.checkDisposed();
		requireMxf(this.htj2k, 'reduced reads require HTJ2K');
		const index = this.packetIndices.get(packet);
		requireMxf(index !== undefined && packet.isMetadataOnly, 'expected an owned metadata packet');
		const location = await this.location(index, signal);
		this.demuxer.checkDisposed();
		requireMxf(location && location.size === packet.byteLength, 'packet location');
		return {
			byteLength: location.size, timestamp: packet.timestamp, duration: packet.duration,
			sequenceNumber: packet.sequenceNumber,
			read: async (start: number, end: number) => {
				this.demuxer.checkDisposed();
				requireMxf(Number.isSafeInteger(start) && Number.isSafeInteger(end)
					&& start >= 0 && end >= start && end <= location.size, 'packet-relative read bounds');
				if (start === end) return new Uint8Array();
				const bytes = await this.demuxer.bytes(
					location.offset + start, end - start, location.offset + end, true, signal,
				);
				this.demuxer.checkDisposed();
				requireMxf(bytes.length === end - start, 'missing packet bytes');
				return bytes.slice();
			},
		};
	}

	private width: number;
	private height: number;
	private squareWidth: number;
	private codec: string;
	private avc: boolean;
	private htj2k: boolean;
	private avcConfig: Promise<VideoDecoderConfig> | null = null;
	private avcParameters: string | null = null;
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
		this.avc = container === AVC_CONTAINER || info.legacyAvc;
		this.htj2k = container === HTJ2K_CONTAINER;
		requireMxf(this.avc
			? [0x28, 0x51].includes(d.kind)
			: this.htj2k ? d.kind === 0x29 : d.kind === 0x28 && container === PRORES_CONTAINER,
		'unsupported picture descriptor or frame wrapping');
		const profile = Number.parseInt(coding.slice(28, 30), 16);
		if (this.avc) {
			requireMxf(info.legacyAvc || (coding.startsWith('060e2b34040101')
				&& ['0401020201312001', '0401020201314001'].includes(coding.slice(16))),
			'unsupported AVC picture coding');
			requireMxf(info.indexSid !== 0, 'AVC requires a temporal index');
			this.codec = 'avc';
		} else if (this.htj2k) {
			requireMxf(coding === '060e2b340401010d0401020203010801', 'unsupported HTJ2K picture coding');
			const layout = property(d, P.pixelLayout, 16);
			const bits = layout[1]!;
			requireMxf(['52084708420800000000000000000000', '52104710421000000000000000000000'].includes(hex(layout)),
				'HTJ2K requires RGB8 or RGB16');
			requireMxf(uint(property(d, P.componentMin), 4) === 0
				&& uint(property(d, P.componentMax), 4) === 2 ** bits - 1, 'HTJ2K requires full-range RGB');
			requireMxf(hex(property(d, P.primaries, 16)) === '060e2b34040101060401010103030000'
				&& hex(property(d, P.transfer, 16)) === '060e2b34040101010401010101020000'
				&& !d.properties.has(P.equations), 'HTJ2K requires BT.709 RGB without coding equations');
			this.codec = 'htj2k';
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
			&& ((number >>> 8) & 255) === (this.avc ? 0x05 : this.htj2k ? 0x08 : 0x17),
		'unsupported picture essence key');
		this.width = uint(property(d, P.width), 4);
		this.height = uint(property(d, P.height), 4);
		requireMxf(this.width > 0 && this.height > 0, 'empty picture');
		if (this.avc) {
			const displayWidth = d.properties.get(P.displayWidth);
			const displayHeight = d.properties.get(P.displayHeight);
			const width = displayWidth ? uint(displayWidth, 4) : this.width;
			const height = displayHeight ? uint(displayHeight, 4) : this.height;
			requireMxf(width > 0 && width <= this.width && height > 0 && height <= this.height,
				'AVC display rectangle exceeds stored picture');
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
	}

	getType() { return 'video' as const; }
	getCodec() { return this.avc ? 'avc' as const : this.htj2k ? 'htj2k' as const : 'prores' as const; }
	override getHasOnlyKeyPackets() { return !this.avc; }
	getInternalCodecId() { return property(this.info.descriptor, P.pictureCoding).slice(); }
	getCodedWidth() { return this.width; }
	getCodedHeight() { return this.height; }
	getSquarePixelWidth() { return this.squareWidth; }
	getSquarePixelHeight() { return this.height; }
	getTransformationMatrix() { return IDENTITY_MATRIX; }
	async canBeTransparent() { return this.codec === 'ap4h' || this.codec === 'ap4x'; }
	append(klv: Klv) {
		this.info.packets.push(this.indexedLocation(klv, this.info.packets.length));
	}

	indexedLocation(klv: Klv, index: number) {
		requireMxf(klv.size >= (this.avc ? 5 : this.htj2k ? 51 : 36), 'truncated picture frame');
		const duration = this.info.rate.denominator / this.info.rate.numerator;
		return { offset: klv.offset, size: klv.size,
			timestamp: index * this.info.rate.denominator / this.info.rate.numerator, duration };
	}

	protected override async readPacket(packet: PacketLocation) {
		const data = await super.readPacket(packet);
		if (this.info.legacyAvc && !packet.isKey) {
			const types = [...iterateNalUnitsInAnnexB(data)].map(nal => extractNalUnitTypeForAvc(data[nal.offset]!));
			if (packet.requiresParameters || types.includes(7) || types.includes(8)) {
				const record = extractAvcDecoderConfigurationRecord(data);
				await this.getDecoderConfig();
				requireMxf(record && avcParameterSets(record) === this.avcParameters,
					'AVC requires stable parameter sets, repeated together');
			}
		}
		if (this.avc && packet.isKey) {
			const record = extractAvcDecoderConfigurationRecord(data);
			requireMxf(record, 'AVC key access unit requires in-band SPS/PPS');
			const types = [...iterateNalUnitsInAnnexB(data)].map(nal => extractNalUnitTypeForAvc(data[nal.offset]!));
			requireMxf(types.includes(5), 'AVC key access unit must contain IDR');
			await this.getDecoderConfig();
			requireMxf(avcParameterSets(record) === this.avcParameters,
				'AVC key access unit changes SPS/PPS; stable parameter sets are required');
		}
		return data;
	}

	getColorSpace(): Promise<VideoColorSpaceInit> {
		if (this.htj2k) {
			return Promise.resolve({ primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true });
		}
		if (this.avc) return this.getDecoderConfig().then(config => config.colorSpace!);
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

	async getDecoderConfig(): Promise<VideoDecoderConfig> {
		if (this.avc) {
			return this.avcConfig ??= (async () => {
				const first = await this.location(0);
				requireMxf(first && first.isKey, 'AVC must start with IDR');
				const data = await this.demuxer.bytes(first.offset, first.size);
				const record = extractAvcDecoderConfigurationRecord(data);
				requireMxf(record && record.sequenceParameterSets.length === 1,
					'AVC first access unit requires SPS/PPS');
				const sps = parseAvcSps(record.sequenceParameterSets[0]!)!;
				requireMxf(!this.info.legacyAvc || sps.profileIdc === 77, 'legacy OPAtom requires AVC Main profile');
				requireMxf(sps.frameMbsOnlyFlag === 1 && sps.chromaFormatIdc === 1
					&& sps.bitDepthLumaMinus8 === 0 && sps.bitDepthChromaMinus8 === 0,
				'AVC requires progressive 8-bit 4:2:0');
				requireMxf(sps.displayWidth === this.width && sps.displayHeight === this.height,
					'AVC SPS geometry disagrees with descriptor');
				const nalTypes = [...iterateNalUnitsInAnnexB(data)]
					.map(nal => extractNalUnitTypeForAvc(data[nal.offset]!));
				requireMxf(nalTypes.includes(5), 'AVC first access unit must contain IDR');
				this.avcParameters = avcParameterSets(record);
				return {
					codec: `avc1.${[record.avcProfileIndication, record.profileCompatibility, record.avcLevelIndication]
						.map(value => value.toString(16).padStart(2, '0')).join('')}`,
					codedWidth: this.width, codedHeight: this.height,
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
			...(this.htj2k ? { description: Uint8Array.of(property(this.info.descriptor, P.pixelLayout)[1]!) } : {}),
		};
	}

	override async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		if (!this.avc) return super.getKeyPacket(timestamp, options);
		let packet = await this.getPacket(timestamp, { metadataOnly: true });
		while (packet) {
			const timing = await this.demuxer.resolveDecode(packet.sequenceNumber, this.info);
			const key = await this.packet(timing.key, options);
			if (!key || key.timestamp <= timestamp) return key;
			if (timing.key === 0) return null;
			packet = await this.packet(timing.key - 1, { metadataOnly: true });
		}
		return null;
	}

	override async getNextKeyPacket(
		packet: EncodedPacket, options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		if (!this.avc) return super.getNextKeyPacket(packet, options);
		const index = this.packetIndices.get(packet);
		if (index === undefined) throw new Error('Packet does not belong to this track.');
		if (this.info.legacyAvc) return null;
		for (let i = index + 1; i < this.info.editUnitCount; i++) {
			const timing = await this.demuxer.resolveDecode(i, this.info);
			if (timing.isKey) return this.packet(i, options);
		}
		return null;
	}
}

class MxfAudioTrackBacking extends MxfTrackBacking implements InputAudioTrackBacking {
	private channels: number;
	private sampleRate: number;
	private blockAlign: number;
	private codec: AudioCodec;
	constructor(demuxer: MxfDemuxer, info: TrackInfo) {
		super(demuxer, info);
		const d = info.descriptor;
		const container = hex(property(d, P.container, 16));
		requireMxf((d.kind === 0x47 && container === AES_CONTAINER)
			|| (d.kind === 0x48 && container === WAVE_CONTAINER),
		'packed frame-wrapped PCM required');
		const coding = d.properties.get(P.soundCoding);
		requireMxf(!coding || [
			'060e2b34040101010402020101000000', '060e2b3404010101040202017f000000',
		].includes(hex(coding)),
		'unsupported sound coding');
		const elementType = d.kind === 0x47 ? 0x03 : 0x01;
		requireMxf((info.trackNumber >>> 24) === 0x16 && ((info.trackNumber >>> 8) & 255) === elementType,
			'PCM essence key');
		const rate = rational(property(d, P.audioRate));
		this.sampleRate = rate.numerator / rate.denominator;
		requireMxf(Number.isInteger(this.sampleRate), 'fractional audio sample rate');
		const descriptorRate = rational(property(d, P.sampleRate));
		requireMxf(equalRationals(descriptorRate, rate) || equalRationals(descriptorRate, info.rate),
			'PCM descriptor sample rate');
		this.channels = uint(property(d, P.channels), 4);
		const bits = uint(property(d, P.bits), 4);
		this.blockAlign = uint(property(d, P.blockAlign), 2);
		requireMxf(this.channels > 0 && [16, 24, 32].includes(bits)
			&& this.blockAlign === this.channels * bits / 8, 'unsupported PCM packing');
		this.codec = bits === 16 ? 'pcm-s16' : bits === 24 ? 'pcm-s24' : 'pcm-s32';
	}

	getType() { return 'audio' as const; }
	getCodec() { return this.codec; }
	getInternalCodecId() { return this.info.descriptor.properties.get(P.soundCoding)?.slice() ?? null; }
	getNumberOfChannels() { return this.channels; }
	getSampleRate() { return this.sampleRate; }
	override getTimeResolution() { return this.sampleRate; }

	override canUseIndex() {
		// ST 382 fixes the sample count for locked audio at integer samples per edit unit.
		const locked = this.info.descriptor.properties.get(P.locked);
		const samplesNumerator = this.sampleRate * this.info.rate.denominator;
		return super.canUseIndex()
			&& !!locked && uint(locked, 1) === 1
			&& Number.isSafeInteger(samplesNumerator) && samplesNumerator % this.info.rate.numerator === 0;
	}

	indexedLocation(klv: Klv, index: number) {
		const samples = this.sampleRate * this.info.rate.denominator / this.info.rate.numerator;
		requireMxf(klv.size === samples * this.blockAlign, 'indexed PCM sample count does not match edit rate');
		requireMxf(Number.isSafeInteger(index * samples), 'PCM sample count overflow');
		return { offset: klv.offset, size: klv.size, timestamp: index * samples / this.sampleRate,
			duration: samples / this.sampleRate };
	}

	append(klv: Klv) {
		requireMxf(klv.size > 0 && klv.size % this.blockAlign === 0, 'PCM payload block alignment');
		const samples = klv.size / this.blockAlign;
		this.info.packets.push({ offset: klv.offset, size: klv.size,
			timestamp: this.info.sampleCount / this.sampleRate, duration: samples / this.sampleRate });
		this.info.sampleCount += samples;
		requireMxf(Number.isSafeInteger(this.info.sampleCount), 'PCM sample count overflow');
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		return { codec: this.codec, numberOfChannels: this.channels, sampleRate: this.sampleRate };
	}
}
