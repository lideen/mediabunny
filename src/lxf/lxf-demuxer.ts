/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { InputAudioTrackBacking, InputTrackBacking, InputVideoTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION } from '../metadata';
import { IDENTITY_MATRIX, UNDETERMINED_LANGUAGE } from '../misc';
import { MPEG2_HEADER_LIMIT, parseMpeg2Headers } from '../mpeg2';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { LXF_CLOCK, LXF_STEP, LXF_WINDOW, LxfPacket, LxfReader, requireLxf } from './lxf-reader';

type Sequence = ReturnType<typeof parseMpeg2Headers>;
const configuration = (header: Sequence) => JSON.stringify([
	header.width, header.height, header.aspect, header.frameRate, header.profileAndLevel,
	header.chromaFormat, header.progressiveSequence, header.colorSpace,
]);

export class LxfDemuxer extends Demuxer {
	private metadata: Promise<InputTrackBacking[]> | null = null;
	private anchors = new Map<number, LxfPacket>();
	private first: LxfPacket[] = [];
	private last: LxfPacket[] | null = null;
	private segment!: LxfPacket;
	private size = 0;
	sequence!: Sequence;

	private reader(signal?: AbortSignal, budget?: number) {
		return new LxfReader(this.input, this.size, signal, budget);
	}

	private validate(packet: LxfPacket) {
		if (packet.type === 2) return;
		requireLxf(packet.timestamp >= this.segment.timestamp
			&& (packet.timestamp - this.segment.timestamp) % LXF_STEP === 0, 'timestamp outside common frame lattice');
		const first = this.first[packet.type];
		if (first) {
			requireLxf(packet.format === first.format && packet.channels === first.channels, 'stream format changed');
		}
	}

	private remember(packets: LxfPacket[], reader: LxfReader) {
		reader.check();
		for (const packet of packets) {
			this.validate(packet);
			if (packet.type === 2) continue;
			for (const known of this.anchors.values()) {
				if (known.offset === packet.offset) continue;
				requireLxf(packet.end <= known.offset || known.end <= packet.offset, 'overlapping packet extents');
				if (known.type === packet.type) {
					requireLxf((known.offset < packet.offset) === (known.timestamp < packet.timestamp)
						&& known.timestamp !== packet.timestamp, 'nonmonotonic track timestamps');
				}
			}
			this.anchors.set(packet.offset, packet);
			if (this.anchors.size > 256) this.anchors.delete(this.anchors.keys().next().value!);
		}
	}

	private async videoHeader(packet: LxfPacket, reader: LxfReader) {
		const header = parseMpeg2Headers(await reader.bytes(packet.payload, Math.min(packet.size, MPEG2_HEADER_LIMIT)));
		requireLxf(header.sequence && header.pictureType === 1 && header.closedGop && header.temporalReference === 0
			&& header.profileAndLevel === 0x82 && header.chromaFormat === 2 && header.frameRate === 25,
		'profile-82 closed I frame with temporal reference zero required');
		if (this.sequence) {
			requireLxf(configuration(header) === configuration(this.sequence), 'MPEG-2 configuration changed');
		}
		return header;
	}

	getTrackBackings() {
		return this.metadata ??= this.initialize();
	}

	private async initialize(): Promise<InputTrackBacking[]> {
		const size = this.input._reader.fileSize;
		requireLxf(size !== null && Number.isSafeInteger(size) && size >= 72, 'known finite file size required');
		this.size = size;
		const reader = this.reader(undefined, 2 * LXF_WINDOW);
		this.segment = await reader.header(0);
		requireLxf(this.segment.type === 2, 'initial segment header required');
		const data = await reader.bytes(this.segment.payload, this.segment.size);
		const frames = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(32, true);
		requireLxf(frames > 0 && frames * LXF_STEP === this.segment.duration,
			'segment frame count and duration disagree');
		let ordinal = 0;
		for (let at = 120; at < data.length; ordinal++) {
			const length = data[at++]!;
			requireLxf(at + length <= data.length, 'truncated extended metadata field');
			if (ordinal === 4 && length) {
				requireLxf(length === 16, 'extended video format field');
				const codes: number[] = [];
				for (let bit = 0; bit < 96; bit++) {
					if (data[at + (bit >> 3)]! & (1 << (bit & 7))) codes.push(bit);
				}
				requireLxf(codes.length === 1 && codes[0]! % 8 === 2, 'extended metadata requires 25 fps');
			}
			at += length;
		}
		let offset = this.segment.end;
		for (let i = 0; i < 4 && this.first.filter(Boolean).length < 2; i++) {
			const packet = await reader.header(offset);
			await reader.linked(packet);
			this.validate(packet);
			if (packet.type !== 2 && !this.first[packet.type]) {
				requireLxf(packet.timestamp === this.segment.timestamp, 'tracks must share the segment origin');
				this.first[packet.type] = packet;
			}
			offset = packet.end;
		}
		requireLxf(this.first[0] && this.first[1], 'initial video and audio tracks required');
		this.sequence = await this.videoHeader(this.first[0], reader);
		this.remember(this.first, reader);
		return [new LxfVideoTrack(this, this.first[0]), new LxfAudioTrack(this, this.first[1])];
	}

	private async tail(signal?: AbortSignal) {
		if (this.last) return this.last;
		const reader = this.reader(signal, 2 * LXF_WINDOW);
		const packets = await reader.scan(Math.max(0, this.size - LXF_WINDOW), this.anchors.values());
		requireLxf(packets.length && packets.at(-1)!.end === this.size
			&& packets.every((p, i) => i === 0 || packets[i - 1]!.end === p.offset),
		'bounded tail is not a chain to EOF');
		const last = [0, 1].map(type => packets.filter(p => p.type === type).at(-1));
		requireLxf(last[0] && last[1], 'per-track endpoint absent from bounded tail');
		requireLxf(last[0].timestamp + last[0].duration === this.segment.timestamp + this.segment.duration,
			'segment duration disagrees with video tail');
		this.remember(packets, reader);
		reader.check();
		return this.last = [last[0], last[1]];
	}

	async endpoint(type: number) {
		const last = (await this.tail())[type]!;
		return (last.timestamp + last.duration) / LXF_CLOCK;
	}

	async locate(type: number, timestamp: number, signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (timestamp < this.segment.timestamp / LXF_CLOCK) return null;
		const last = (await this.tail(signal))[type]!;
		if (timestamp >= last.timestamp / LXF_CLOCK) return last;
		const target = timestamp * LXF_CLOCK;
		const reader = this.reader(signal);
		const anchors = new Map(this.anchors);
		for (const packet of [...this.first, ...this.last!]) anchors.set(packet.offset, packet);
		let previous = '';
		let fallback = false;
		while (true) {
			reader.check();
			const packets = [...anchors.values()].filter(p => p.type === type).sort((a, b) => a.offset - b.offset);
			const covering = packets.find(p => p.timestamp / LXF_CLOCK <= timestamp
				&& timestamp < (p.timestamp + p.duration) / LXF_CLOCK);
			if (covering) return covering;
			const lower = packets.filter(p => p.timestamp / LXF_CLOCK <= timestamp).at(-1);
			const upper = packets.find(p => p.timestamp / LXF_CLOCK > timestamp);
			requireLxf(lower && upper, 'seek lacks timestamp bracket');
			const bracket = `${lower.offset}:${upper.offset}`;
			if (bracket === previous) {
				requireLxf(!fallback, 'seek failed to progress within bounded bracket');
				fallback = true;
			} else fallback = false;
			requireLxf(upper.offset > lower.end, 'uncovered timestamp gap');
			const fraction = (target - lower.timestamp) / (upper.timestamp - lower.timestamp);
			const estimate = fallback
				? lower.end + (upper.offset - lower.end) / 2
				: lower.offset + fraction * (upper.offset - lower.offset);
			const bounded = Math.max(lower.end, Math.min(upper.offset - 1, Math.floor(estimate)));
			let start = bounded - LXF_WINDOW / 2;
			const partner = [...anchors.values()].find(p => p.type === 1 - type
				&& p.timestamp <= target && target < p.timestamp + p.duration);
			if (partner && !fallback) {
				start = Math.max(lower.end, Math.min(partner.offset - LXF_WINDOW + 72, upper.offset - 1));
			}
			start = Math.max(0, Math.min(Math.max(0, this.size - LXF_WINDOW), start));
			const found = await reader.scan(start, anchors.values());
			this.remember(found, reader);
			for (const packet of found) if (packet.type !== 2) anchors.set(packet.offset, packet);
			requireLxf(anchors.size <= 512, 'seek anchor budget exhausted');
			previous = bracket;
		}
	}

	async next(packet: LxfPacket, signal?: AbortSignal): Promise<LxfPacket | null> {
		const reader = this.reader(signal);
		let offset = packet.end;
		for (let i = 0; i < 32; i++) {
			reader.check();
			if (offset === this.size) return null;
			const next = await reader.header(offset);
			await reader.linked(next);
			this.remember([next], reader);
			if (next.type === packet.type) {
				requireLxf(next.timestamp === packet.timestamp + packet.duration, 'noncontiguous track interval');
				return next;
			}
			offset = next.end;
		}
		throw new Error('Unsupported LXF: next-packet envelope budget exhausted');
	}

	async packet(packet: LxfPacket, options: PacketRetrievalOptions) {
		const reader = this.reader(options.signal);
		reader.check();
		if (packet.type === 0) await this.videoHeader(packet, reader);
		let data = PLACEHOLDER_DATA;
		if (!options.metadataOnly) {
			const wire = await reader.bytes(packet.payload, packet.size);
			data = new Uint8Array(packet.size);
			if (packet.type === 0) data.set(wire);
			else {
				const plane = packet.size / packet.channels;
				for (let i = 0; i < plane / 3; i++) {
					for (let channel = 0; channel < packet.channels; channel++) {
						const from = channel * plane + i * 3;
						data.set(wire.subarray(from, from + 3), (i * packet.channels + channel) * 3);
					}
				}
			}
		}
		reader.check();
		return new EncodedPacket(data, 'key', packet.timestamp / LXF_CLOCK, packet.duration / LXF_CLOCK,
			(packet.timestamp - this.segment.timestamp) / LXF_STEP, packet.size);
	}

	async getMimeType() { return 'application/x-lxf'; }
	async getMetadataTags() { return {}; }
}

abstract class LxfTrack implements InputTrackBacking {
	private packets = new WeakMap<EncodedPacket, LxfPacket>();
	constructor(protected demuxer: LxfDemuxer, protected first: LxfPacket) {}
	abstract getType(): 'video' | 'audio';
	abstract getCodec(): 'mpeg2' | 'pcm-s24';
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig>;
	getId() { return this.first.type + 1; }
	getNumber() { return this.getId(); }
	getInternalCodecId() { return this.first.format; }
	getName() { return null; }
	getLanguageCode() { return UNDETERMINED_LANGUAGE; }
	getTimeResolution() { return LXF_CLOCK; }
	isRelativeToUnixEpoch() { return false; }
	getUnixTimeForTimestamp() { return null; }
	getDisposition() { return { ...DEFAULT_TRACK_DISPOSITION }; }
	getPairingMask() { return 1n; }
	getBitrate() { return null; }
	getAverageBitrate() { return null; }
	getDurationFromMetadata() { return this.demuxer.endpoint(this.first.type); }
	async getLiveRefreshInterval() { return null; }
	getHasOnlyKeyPackets() { return true; }
	private async emit(packet: LxfPacket | null, options: PacketRetrievalOptions) {
		if (!packet) return null;
		const output = await this.demuxer.packet(packet, options);
		this.packets.set(output, packet);
		return output;
	}

	getFirstPacket(options: PacketRetrievalOptions) { return this.emit(this.first, options); }
	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.emit(await this.demuxer.locate(this.first.type, timestamp, options.signal), options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const original = this.packets.get(packet);
		requireLxf(original, 'packet does not belong to this track');
		return this.emit(await this.demuxer.next(original, options.signal), options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) { return this.getPacket(timestamp, options); }
	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}

class LxfVideoTrack extends LxfTrack implements InputVideoTrackBacking {
	getType() { return 'video' as const; }
	getCodec() { return 'mpeg2' as const; }
	getCodedWidth() { return this.demuxer.sequence.width; }
	getCodedHeight() { return this.demuxer.sequence.height; }
	getSquarePixelWidth() {
		const { aspect, width, height } = this.demuxer.sequence;
		return aspect === 1 ? width : height * [0, 0, 4 / 3, 16 / 9, 2.21][aspect]!;
	}

	getSquarePixelHeight() { return this.getCodedHeight(); }
	getTransformationMatrix() { return IDENTITY_MATRIX; }
	async getColorSpace() { return this.demuxer.sequence.colorSpace ?? {}; }
	async canBeTransparent() { return false; }
	async getDecoderConfig(): Promise<VideoDecoderConfig> {
		return { codec: 'mpeg2', codedWidth: this.getCodedWidth(), codedHeight: this.getCodedHeight(),
			colorSpace: await this.getColorSpace() };
	}
}

class LxfAudioTrack extends LxfTrack implements InputAudioTrackBacking {
	getType() { return 'audio' as const; }
	getCodec() { return 'pcm-s24' as const; }
	getNumberOfChannels() { return this.first.channels; }
	getSampleRate() { return 48000; }
	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		return { codec: 'pcm-s24', numberOfChannels: this.getNumberOfChannels(), sampleRate: this.getSampleRate() };
	}
}
