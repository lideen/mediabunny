import { InputVideoTrack, VideoSample, VideoSampleSink } from 'mediabunny';
import { MetadataLookahead, PrefixPolicy } from './metadata-lookahead.js';

type State = 'paused' | 'seeking' | 'starting' | 'playing' | 'buffering' | 'ended' | 'error';
const LOW_PREFIX: PrefixPolicy = { bytes: 16 * 1024 + 25, frames: 104 };
const STANDARD_PREFIX: PrefixPolicy = { bytes: 64 * 1024, frames: 104 };
const HIGH_PREFIX: PrefixPolicy = { bytes: 64 * 1024, frames: 72 };
const TIERS = [
	{ width: 60, height: 34, prefix: LOW_PREFIX },
	{ width: 120, height: 68, prefix: STANDARD_PREFIX },
	{ width: 240, height: 135, prefix: HIGH_PREFIX },
	{ width: 480, height: 270, prefix: HIGH_PREFIX },
];
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SAMPLE_BYTES = 480 * 270 * 4;
const EPSILON = 1e-7;

/** Example-only video clock and owned sample queue. The caller supplies render opportunities in seconds. */
export class SmoothPlayback {
	state: State = 'paused';
	refining = false;
	resolution = '';
	lateness = 0;
	private queue: VideoSample[] = [];
	private bytes = 0;
	private pendingBytes = 0;
	private generation = 0;
	private producerEpoch = 0;
	private refineEpoch = 0;
	private producer: ReturnType<VideoSampleSink['samples']> | null = null;
	private metadata: MetadataLookahead | null = null;
	private refinement: ReturnType<VideoSampleSink['samplesAtTimestamps']> | null = null;
	private cleanup: Promise<unknown> = Promise.resolve();
	private wake: (() => void) | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private tier = 1;
	private eof = false;
	private displayed = 0;
	private displayedEnd = 0;
	private nextTimestamp = 0;
	private anchorWall = 0;
	private anchorMedia = 0;
	private lastTick = 0;
	private rate = 0;
	private rateEpoch = 0;
	private startupIntent: number | null = null;
	private stableSince = 0;
	private upgradeAfter = 0;
	private previousBuffer = 0;
	private resumeAfterSeek = false;
	private actualTiers = new Map<number, string>();

	constructor(private track: InputVideoTrack, private draw: (sample: VideoSample) => void,
		private reportError: (error: unknown) => void) {}

	get bufferedSeconds() { return Math.max(0, this.nextTimestamp - this.displayedEnd); }
	get ownedBytes() { return this.bytes + this.pendingBytes; }
	get timestamp() { return this.displayed; }
	get wantsPlay() {
		if (this.state === 'seeking') return this.resumeAfterSeek;
		return ['starting', 'playing', 'buffering'].includes(this.state);
	}

	private sink(tier: number) {
		return new VideoSampleSink(this.track, { reducedResolution: TIERS[tier]! });
	}

	private async next<T>(iterator: AsyncIterator<T, void>) {
		this.pendingBytes += MAX_SAMPLE_BYTES;
		try {
			return await iterator.next();
		} finally {
			this.pendingBytes -= MAX_SAMPLE_BYTES;
		}
	}

	private cancelRefinement() {
		this.refineEpoch++;
		clearTimeout(this.timer);
		this.refining = false;
		const iterator = this.refinement;
		this.refinement = null;
		this.cleanup = Promise.all([this.cleanup, iterator?.return().catch(() => {})]);
		return this.cleanup;
	}

	private stopProducer() {
		this.producerEpoch++;
		this.wake?.();
		this.wake = null;
		const iterator = this.producer;
		this.producer = null;
		this.cleanup = Promise.all([this.cleanup, iterator?.return().catch(() => {})]);
		return this.cleanup;
	}

	private clearQueue() {
		for (const sample of this.queue) sample.close();
		this.queue = [];
		this.bytes = 0;
	}

	private stopMetadata() {
		const metadata = this.metadata;
		this.metadata = null;
		this.cleanup = Promise.all([this.cleanup, metadata?.dispose()]);
		return this.cleanup;
	}

	async dispose() {
		this.generation++;
		this.startupIntent = null;
		this.state = 'paused';
		this.clearQueue();
		await Promise.all([this.stopProducer(), this.cancelRefinement(), this.stopMetadata()]);
	}

	private fail(error: unknown) {
		void this.dispose();
		this.state = 'error';
		this.reportError(error);
	}

	private display(sample: VideoSample) {
		this.resolution = `${sample.codedWidth}×${sample.codedHeight}`;
		this.draw(sample);
		this.displayed = sample.timestamp;
		this.displayedEnd = sample.timestamp + sample.duration;
		this.metadata?.advance(this.displayedEnd);
	}

	async seek(timestamp: number, resume = false) {
		const cleanup = this.dispose();
		const generation = this.generation;
		this.state = 'seeking';
		this.resumeAfterSeek = resume;
		if (resume) this.startupIntent = performance.now() / 1000;
		await cleanup;
		if (generation !== this.generation) return;
		this.eof = false;
		this.rate = 0;
		this.displayed = timestamp;
		this.displayedEnd = timestamp;
		this.nextTimestamp = timestamp;
		this.resolution = '';
		this.lateness = 0;
		const epoch = ++this.refineEpoch;
		const iterator = this.sink(this.tier).samplesAtTimestamps([timestamp]);
		this.refinement = iterator;
		try {
			const sample = (await this.next(iterator)).value;
			if (sample) {
				try {
					if (generation !== this.generation || epoch !== this.refineEpoch) return;
					this.validateSample(sample);
					this.display(sample);
					this.nextTimestamp = this.displayedEnd;
				} finally { sample.close(); }
			} else if (generation === this.generation && epoch === this.refineEpoch) {
				this.eof = true;
				this.state = 'ended';
			}
		} catch (error) {
			if (generation === this.generation) this.fail(error);
		} finally {
			await iterator.return();
			if (this.refinement === iterator) this.refinement = null;
		}
		if (generation !== this.generation) return;
		if (!this.eof) {
			this.state = 'paused';
			if (this.resumeAfterSeek) this.play();
		}
	}

	play() {
		if (this.state === 'seeking') {
			this.startupIntent ??= performance.now() / 1000;
			this.resumeAfterSeek = true;
			return;
		}
		if (this.wantsPlay) return;
		this.startupIntent ??= performance.now() / 1000;
		void this.cancelRefinement();
		this.state = 'starting';
		this.stableSince = this.lastTick;
		this.startProducer();
	}

	pause() {
		this.generation++;
		this.startupIntent = null;
		this.state = 'paused';
		void this.stopProducer();
		void this.cancelRefinement();
		void this.stopMetadata();
		this.clearQueue();
		this.nextTimestamp = this.displayedEnd;
		this.eof = false;
		const generation = this.generation;
		this.timer = setTimeout(() => {
			void this.refine(generation).catch((error) => {
				if (generation === this.generation) this.fail(error);
			});
		}, 200);
	}

	private async refine(generation: number) {
		await this.cleanup;
		if (generation !== this.generation || this.state !== 'paused') return;
		const epoch = ++this.refineEpoch;
		const iterator = this.sink(3).samplesAtTimestamps([this.displayed]);
		this.refinement = iterator;
		this.refining = true;
		try {
			const sample = (await this.next(iterator)).value;
			if (sample) {
				try {
					if (generation === this.generation && epoch === this.refineEpoch && this.state === 'paused') {
						this.validateSample(sample);
						this.display(sample);
					}
				} finally { sample.close(); }
			}
		} finally {
			await iterator.return();
			if (epoch === this.refineEpoch) this.refining = false;
			if (this.refinement === iterator) this.refinement = null;
		}
	}

	private validateSample(sample: VideoSample) {
		if (sample.codedWidth > 480 || sample.codedHeight > 270 || sample.duration <= 0
			|| sample.allocationSize() > MAX_SAMPLE_BYTES) {
			throw new Error('Smooth playback requires a reduced native level within 480×270 and positive durations.');
		}
	}

	private startProducer() {
		const generation = this.generation;
		const epoch = ++this.producerEpoch;
		void this.fill(generation, epoch).catch((error) => {
			if (generation === this.generation && epoch === this.producerEpoch) this.fail(error);
		});
	}

	private async fill(generation: number, epoch: number) {
		await this.cleanup;
		const active = () => generation === this.generation && epoch === this.producerEpoch && this.wantsPlay;
		if (!active()) return;
		if (!this.metadata) {
			this.metadata = new MetadataLookahead(this.track, this.displayedEnd, (error) => {
				if (generation === this.generation) this.fail(error);
			}, TIERS[this.tier]!.prefix);
		}
		const metadata = this.metadata;
		const tier = this.tier;
		let iterator: ReturnType<VideoSampleSink['samples']> | null = null;
		let initial = true;
		let wall = 0;
		let media = 0;
		let rateEpoch = this.rateEpoch;
		try {
			while (active()) {
				// Reserve the largest admitted RGBA frame before asking the core for another sample.
				while (active() && (this.bufferedSeconds >= 3 - EPSILON
					|| this.ownedBytes + MAX_SAMPLE_BYTES > MAX_BYTES)) {
					await new Promise<void>((resolve) => {
						this.wake = resolve;
					});
				}
				if (!active()) break;
				const started = performance.now();
				if (!await metadata.ensure(this.nextTimestamp)) {
					if (active()) this.eof = true;
					break;
				}
				if (!active()) break;
				if (!iterator) {
					iterator = this.sink(tier).samples(this.nextTimestamp);
					this.producer = iterator;
				}
				const result = await this.next(iterator);
				const sample = result.value;
				if (!sample) {
					if (active()) this.eof = true;
					break;
				}
				let admitted = false;
				try {
					if (!active()) break;
					this.validateSample(sample);
					if (initial && sample.timestamp < this.nextTimestamp - EPSILON) continue;
					initial = false;
					if (Math.abs(sample.timestamp - this.nextTimestamp) > EPSILON) {
						throw new Error('Non-contiguous smooth playback samples.');
					}
					const size = sample.allocationSize();
					if (this.bytes + size > MAX_BYTES) throw new Error('Smooth playback sample budget exceeded.');
					this.queue.push(sample);
					this.bytes += size;
					admitted = true;
					this.nextTimestamp = sample.timestamp + sample.duration;
					this.actualTiers.set(tier, `${sample.codedWidth}×${sample.codedHeight}`);
					if (rateEpoch !== this.rateEpoch) {
						rateEpoch = this.rateEpoch;
						wall = 0;
						media = 0;
					} else {
						wall += (performance.now() - started) / 1000;
						media += sample.duration;
					}
					if (media >= 0.5) {
						const rate = media / Math.max(wall, 0.001);
						this.rate = this.rate ? 0.5 * this.rate + 0.5 * rate : rate;
						media = 0;
						wall = 0;
					}
				} finally { if (!admitted) sample.close(); }
			}
		} finally {
			await iterator?.return();
			if (this.producer === iterator) this.producer = null;
		}
	}

	private switchTier(tier: number) {
		this.tier = tier;
		this.metadata?.setPrefixPolicy(TIERS[tier]!.prefix);
		this.rate = 0;
		this.stableSince = this.lastTick;
		this.upgradeAfter = this.lastTick + 10;
		void this.stopProducer();
		this.startProducer();
	}

	tick(now: number) {
		this.lastTick = now;
		if (!this.wantsPlay || this.state === 'seeking') return;
		if (this.state !== 'playing') {
			if (this.bufferedSeconds < 2 - EPSILON && !this.eof) {
				if (this.startupIntent !== null && this.tier === 1) {
					if (now - this.startupIntent >= 6) this.switchTier(0);
				} else if (this.tier > 0 && this.rate > 0 && this.rate < 1 && now - this.stableSince >= 2) {
					this.switchTier(this.tier - 1);
				}
				return;
			}
			if (this.startupIntent !== null) {
				this.startupIntent = null;
				this.rate = 0;
				this.rateEpoch++;
			}
			this.state = 'playing';
			this.anchorWall = now;
			this.anchorMedia = this.displayedEnd;
			this.stableSince = now;
		}
		const due = this.anchorMedia + now - this.anchorWall;
		const sample = this.queue[0];
		if (sample && sample.timestamp <= due + EPSILON) {
			this.queue.shift();
			this.bytes -= sample.allocationSize();
			const duration = sample.duration;
			const timestamp = sample.timestamp;
			try {
				this.display(sample);
			} catch (error) {
				this.fail(error);
				return;
			} finally { sample.close(); }
			this.lateness = Math.max(0, due - timestamp);
			if (this.lateness >= duration) {
				this.anchorWall = now;
				this.anchorMedia = timestamp;
			}
			this.wake?.();
			this.wake = null;
		} else if (!sample && due >= this.displayedEnd) {
			this.state = this.eof ? 'ended' : 'buffering';
			if (!this.eof && this.tier > 0) {
				this.switchTier(this.tier - 1);
			}
		}
		if (this.state === 'playing' && !this.eof) {
			if (this.bufferedSeconds <= 1.5) this.stableSince = now;
			if (this.bufferedSeconds < 0.5 && this.bufferedSeconds < this.previousBuffer
				&& this.rate > 0 && this.rate < 1 && this.tier > 0) {
				this.switchTier(this.tier - 1);
			} else if (this.tier < 3 && now >= this.upgradeAfter && now - this.stableSince >= 5
				&& this.bufferedSeconds > 1.5 && this.rate >= 5
				&& this.actualTiers.get(this.tier + 1) !== this.actualTiers.get(this.tier)) {
				this.switchTier(this.tier + 1);
			}
		}
		this.previousBuffer = this.bufferedSeconds;
	}
}
