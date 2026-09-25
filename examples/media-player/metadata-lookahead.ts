import { EncodedPacket, EncodedPacketSink, InputVideoTrack } from 'mediabunny';

export const SMOOTH_FETCH_CONCURRENCY = 48;
const MAX_PREFIX_BYTES = 104 * 64 * 1024;

const EPSILON = 1e-7;
export type PrefixPolicy = {
	readonly bytes: number;
	readonly frames: number;
};
type Entry = {
	ready: Promise<void>;
	abort: AbortController;
	bytes: number;
	settled: boolean;
};

/** Reserves bounded indexed header/prefix reads, anchored to the next displayed frame, not the decoder. */
export class MetadataLookahead {
	private sink: EncodedPacketSink;
	private abort = new AbortController();
	private ready: Promise<void>;
	private entries = new Map<number, Entry>();
	private tasks = new Set<Promise<void>>();
	private reservedBytes = 0;
	private active = 0;
	private first: EncodedPacket | null = null;
	private sequenceStep = 1;
	private count = 0;
	private displayIndex = 0;
	private nextIndex = 0;
	private initialized = false;

	constructor(private track: InputVideoTrack, private nextDisplayTimestamp: number,
		private onError: (error: unknown) => void, private policy: PrefixPolicy) {
		this.sink = new EncodedPacketSink(track);
		this.ready = this.initialize().catch(error => this.fail(error));
	}

	private fail(error: unknown) {
		if (this.abort.signal.aborted) return;
		this.abort.abort(error);
		this.onError(error);
	}

	private async initialize() {
		const options = { metadataOnly: true, signal: this.abort.signal };
		const first = await this.sink.getFirstPacket(options);
		const end = await this.track.getDurationFromMetadata();
		this.abort.signal.throwIfAborted();
		if (!first || first.type !== 'key' || first.duration <= 0 || !first.isMetadataOnly
			|| !Number.isSafeInteger(first.sequenceNumber) || first.sequenceNumber < 0 || end === null) {
			throw new Error('Smooth metadata lookahead requires known-duration, indexed all-intra CFR video.');
		}
		this.first = first;
		this.count = Math.round((end - first.timestamp) / first.duration);
		if (this.count < 1 || !Number.isSafeInteger(this.count)
			|| Math.abs(first.timestamp + this.count * first.duration - end) > EPSILON) {
			throw new Error('Smooth metadata lookahead requires an integral CFR duration.');
		}
		let interval = first.duration;
		if (this.count > 1) {
			const second = await this.sink.getNextPacket(first, options);
			this.sequenceStep = (second?.sequenceNumber ?? -1) - first.sequenceNumber;
			if (!second || !Number.isSafeInteger(this.sequenceStep) || this.sequenceStep <= 0) {
				throw new Error('Smooth metadata lookahead requires increasing packet sequence numbers.');
			}
			this.validate(second, 1);
			interval = second.timestamp - first.timestamp;
		}
		if (!(Math.abs(interval - 1 / 24) <= EPSILON)) {
			throw new Error('Smooth playback requires 24 fps (24/1) video; other frame rates are not supported.');
		}
		this.abort.signal.throwIfAborted();
		this.displayIndex = this.indexAt(this.nextDisplayTimestamp);
		this.nextIndex = this.displayIndex;
		this.initialized = true;
		this.pump();
	}

	private indexAt(timestamp: number) {
		const first = this.first!;
		const index = Math.round((timestamp - first.timestamp) / first.duration);
		if (index < 0 || Math.abs(first.timestamp + index * first.duration - timestamp) > EPSILON) {
			throw new Error('Smooth metadata lookahead requires frame-aligned CFR timestamps.');
		}
		return index;
	}

	private validate(packet: EncodedPacket | null, index: number) {
		const first = this.first!;
		if (!packet || !packet.isMetadataOnly || packet.type !== 'key'
			|| packet.sequenceNumber !== first.sequenceNumber + index * this.sequenceStep
			|| Math.abs(packet.timestamp - (first.timestamp + index * first.duration)) > EPSILON
			|| Math.abs(packet.duration - first.duration) > EPSILON) {
			throw new Error('Smooth metadata lookahead encountered non-contiguous or non-CFR packet metadata.');
		}
	}

	private pump() {
		const policy = this.policy;
		while (!this.abort.signal.aborted && this.active < SMOOTH_FETCH_CONCURRENCY
			&& this.nextIndex < Math.min(this.displayIndex + policy.frames, this.count)) {
			const bytes = policy.bytes;
			if (this.reservedBytes + bytes > MAX_PREFIX_BYTES) break;
			const index = this.nextIndex++;
			this.active++;
			// Query inside the frame so floating-point rounding cannot select its predecessor.
			const timestamp = this.first!.timestamp + (index + 0.5) * this.first!.duration;
			const entry: Entry = { ready: Promise.resolve(), abort: new AbortController(), bytes, settled: false };
			this.entries.set(index, entry);
			this.reservedBytes += bytes;
			const signal = AbortSignal.any([this.abort.signal, entry.abort.signal]);
			entry.ready = this.sink.getPacket(timestamp, { metadataOnly: true, signal, prefetchBytes: bytes })
				.then((packet) => {
					this.validate(packet, index);
				})
				.catch((error) => {
					if (!entry.abort.signal.aborted) this.fail(error);
				})
				.finally(() => {
					entry.settled = true;
					if (this.entries.get(index) !== entry) this.reservedBytes -= bytes;
					this.tasks.delete(entry.ready);
					this.active--;
					this.pump();
				});
			this.tasks.add(entry.ready);
		}
	}

	setPrefixPolicy(policy: PrefixPolicy) {
		this.policy = policy;
		if (this.initialized) this.pump();
	}

	advance(nextDisplayTimestamp: number) {
		this.nextDisplayTimestamp = nextDisplayTimestamp;
		if (!this.first || this.abort.signal.aborted) return;
		this.displayIndex = this.indexAt(nextDisplayTimestamp);
		for (const [index, entry] of this.entries) {
			if (index < this.displayIndex) {
				this.entries.delete(index);
				if (entry.settled) this.reservedBytes -= entry.bytes;
				entry.abort.abort();
			}
		}
		// Initialization may still be validating the second packet.
		if (this.initialized) this.pump();
	}

	async ensure(timestamp: number) {
		await this.ready;
		this.abort.signal.throwIfAborted();
		const index = this.indexAt(timestamp);
		if (index >= this.count) return false;
		const pending = this.entries.get(index);
		if (!pending) throw new Error('Smooth playback exceeded its display-anchored metadata horizon.');
		await pending.ready;
		this.abort.signal.throwIfAborted();
		return true;
	}

	async dispose() {
		this.abort.abort();
		await this.ready;
		await Promise.all(this.tasks);
		this.entries.clear();
		this.reservedBytes = 0;
	}
}
