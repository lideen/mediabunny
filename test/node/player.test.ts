import { afterEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({
	clock: 0,
	release: () => {},
	releaseAudio: () => {},
	draws: [] as number[],
	audioStarts: [] as number[],
	end: 0.12,
	videoStart: 0,
	finalVideoOffset: 0.08,
	live: false,
	codec: 'avc',
	audio: true,
	width: 16,
	audioContexts: 0,
	smoothDisposal: null as Promise<void> | null,
	smoothSeeks: [] as number[],
	smoothSteps: [] as { gate?: Promise<void>; error?: Error; reject?: boolean; retired?: boolean }[],
	previewGate: null as Promise<void> | null,
	lookaheadGate: null as Promise<void> | null,
}));
vi.mock('@mediabunny/ac3', () => ({ registerAc3Decoder: () => {} }));
vi.mock('@mediabunny/dts', () => ({ registerDtsDecoder: () => {} }));
vi.mock('@mediabunny/prores', () => ({ registerProresDecoder: () => {} }));
vi.mock('@mediabunny/htj2k', () => ({ registerHtj2kDecoder: () => {} }));
vi.mock('../../examples/media-player/smooth-playback.js', () => ({
	SmoothPlayback: class {
		state = 'paused';
		timestamp = 0;
		wantsPlay = false;
		refining = false;
		resolution = '120×68';
		bufferedSeconds = 0;
		ownedBytes = 0;
		lateness = 0;
		constructor(_track: unknown, private draw: (sample: unknown) => void,
			private reportError: (error: unknown) => void) {}

		async seek(timestamp: number, resume = false) {
			media.smoothSeeks.push(timestamp);
			const step = media.smoothSteps.shift();
			this.state = 'seeking';
			await step?.gate;
			if (step?.retired) {
				return;
			}
			if (step?.error) {
				if (step.reject) {
					throw step.error;
				}
				this.state = 'error';
				this.wantsPlay = false;
				this.reportError(step.error);
				return;
			}
			this.timestamp = timestamp;
			this.state = resume ? 'playing' : 'paused';
			this.wantsPlay = resume;
			this.draw({ drawWithFit: () => media.draws.push(timestamp) });
		}

		play() {
			this.state = 'playing';
			this.wantsPlay = true;
		}

		pause() {
			this.state = 'paused';
			this.wantsPlay = false;
		}

		async dispose() { await media.smoothDisposal; }
		tick() {}
	},
}));
vi.mock('mediabunny', async (original) => {
	const metadata = {
		isRelativeToUnixEpoch: () => false,
		getLiveRefreshInterval: () => media.live ? 1 : null,
		isLive: () => media.live,
	};
	const videoTrack = {
		...metadata, getCodec: () => media.codec, canDecode: () => true,
		getCodedWidth: () => media.width, getCodedHeight: () => 540,
		getFirstTimestamp: () => media.videoStart,
		getDurationFromMetadata: () => media.end,
		getDisplayWidth: () => 16, getDisplayHeight: () => 16, canBeTransparent: () => false,
	};
	const audioTrack = {
		...metadata, getCodec: () => 'aac', canDecode: () => true, getSampleRate: () => 48000,
	};
	return {
		...await original<object>(),
		Input: class {
			getPrimaryVideoTrack() { return videoTrack; }
			getPrimaryAudioTrack() { return media.audio ? audioTrack : null; }
			getAudioTracks() { return media.audio ? [audioTrack] : []; }
			getFirstTimestamp() { return 0; }
			getDurationFromMetadata() { return media.end; }
			dispose() {}
		},
		EncodedPacketSink: class {
			async getFirstPacket() { return { type: 'key', duration: 1 / 24, timestamp: 0 }; }
			async prefetchPacketRange() {}
		},
		CanvasSink: class {
			pool: { pixels: number }[];
			index = 0;
			constructor(_track: unknown, options: { poolSize?: number }) {
				this.pool = Array.from({ length: options.poolSize ?? 0 }, () => ({ pixels: 0 }));
			}

			frame(timestamp: number) {
				const canvas = this.pool[this.index] ?? { pixels: 0 };
				this.index = (this.index + 1) % this.pool.length;
				canvas.pixels = timestamp;
				return { timestamp, canvas };
			}

			async getCanvas(timestamp: number) {
				await media.previewGate;
				return timestamp < media.videoStart ? null : this.frame(timestamp);
			}

			async* canvases(timestamp: number) {
				await media.previewGate;
				timestamp = Math.max(timestamp, media.videoStart);
				yield this.frame(timestamp);
				await media.lookaheadGate;
				yield this.frame(timestamp + 0.04);
				await new Promise<void>((resolve) => {
					media.release = resolve;
				});
				yield this.frame(timestamp + media.finalVideoOffset);
			}
		},
		AudioBufferSink: class {
			async* buffers() {
				// Audio ends one 25 fps interval before video.
				yield { timestamp: 0, buffer: { duration: 0.04 } };
				await new Promise<void>((resolve) => {
					media.releaseAudio = resolve;
				});
				yield { timestamp: 0.04, buffer: { duration: 0.04 } };
			}
		},
	};
});

class Element extends EventTarget {
	style: Record<string, string> = {};
	textContent = '';
	children: Element[] = [];
	getContext() {
		return { clearRect: () => {}, drawImage: (frame: { pixels: number }) => media.draws.push(frame.pixels) };
	}

	click() { this.dispatchEvent(new Event('click')); }
}

const settle = async () => {
	for (let i = 0; i < 100; i++) {
		await Promise.resolve();
	}
};

const loadPlayer = async ({
	live = false, lookaheadGate = null, videoStart = 0, finalVideoOffset = 0.08,
	query = '', codec = 'avc', audio = true, width = 16,
}: {
	live?: boolean;
	lookaheadGate?: Promise<void> | null;
	videoStart?: number;
	finalVideoOffset?: number;
	query?: string;
	codec?: string;
	audio?: boolean;
	width?: number;
} = {}) => {
	vi.resetModules();
	vi.useFakeTimers();
	media.clock = 0;
	media.draws = [];
	media.audioStarts = [];
	media.end = 0.12;
	media.videoStart = videoStart;
	media.finalVideoOffset = finalVideoOffset;
	media.live = live;
	media.codec = codec;
	media.audio = audio;
	media.width = width;
	media.audioContexts = 0;
	media.smoothDisposal = null;
	media.smoothSeeks = [];
	media.smoothSteps = [];
	media.previewGate = null;
	media.lookaheadGate = lookaheadGate;
	const elements = new Map<string, Element>();
	const element = (selector: string) => {
		if (!elements.has(selector)) {
			elements.set(selector, new Element());
		}
		return elements.get(selector)!;
	};
	const window = Object.assign(new EventTarget(), {
		innerWidth: 800, setTimeout,
		AudioContext: class {
			constructor() { media.audioContexts++; }
			state = 'running';
			sampleRate = 48000;
			destination = {};
			get currentTime() { return media.clock; }
			createGain() { return { gain: { value: 1 }, connect: () => {} }; }
			createBufferSource() {
				return { connect: () => {}, start: (time: number) => media.audioStarts.push(time), stop: () => {} };
			}

			async close() {}
		},
	});
	vi.stubGlobal('window', window);
	vi.stubGlobal('location', { search: query });
	vi.stubGlobal('document', Object.assign(new EventTarget(), { querySelector: element }));
	vi.stubGlobal('prompt', () => 'https://example.invalid/authored');
	let render = () => {};
	vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
		render = callback;
	});
	await import('../../examples/media-player/media-player.js');
	element('#load-url').click();
	await settle();
	return {
		element, window, tick: () => render(),
		start: async () => {
			element('#play-button').click();
			await settle();
			media.clock = 0.04;
			render();
			await settle();
		},
	};
};

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('given the media player example', () => {
	describe('when using smooth video controls', () => {
		const smoothOptions = { query: '?smooth=1&minimumRequestSize=32768', codec: 'htj2k',
			audio: false, width: 960 };
		const key = (player: Awaited<ReturnType<typeof loadPlayer>>, code: string) => {
			player.window.dispatchEvent(Object.assign(new Event('keydown'), { code }));
		};

		it('should ignore playback controls while an old controller is disposing during reload', async () => {
			const player = await loadPlayer(smoothOptions);
			expect(media.draws).toEqual([0]);
			let release!: () => void;
			media.smoothDisposal = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				player.element('#load-url').click();
				await settle();
				key(player, 'Space');
				await settle();
				expect(player.element('#player').style['display']).toBe('none');
				expect(media.audioContexts).toBe(0);
				expect(media.draws).toEqual([0]);
			} finally {
				release();
				media.smoothDisposal = null;
				await settle();
			}
			player.tick();
			expect(player.element('#player').style['display']).toBe('');
			expect(player.element('#error-element').textContent).toBe('');
			expect(media.draws).toEqual([0, 0]);
		});

		it('should clear a transient seek failure only after a successful seek and allow resume', async () => {
			const player = await loadPlayer(smoothOptions);
			media.smoothSteps.push({ error: new Error('Transient decode failure') });
			key(player, 'ArrowRight');
			await settle();
			expect(player.element('#error-element').textContent).toContain('Transient decode failure');
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			media.smoothSteps.push({ gate });
			try {
				key(player, 'ArrowLeft');
				await settle();
				expect(player.element('#error-element').textContent).toContain('Transient decode failure');
			} finally {
				release();
				await settle();
			}
			key(player, 'Space');
			await settle();
			player.tick();
			expect(player.element('#error-element').textContent).toBe('');
			expect(player.element('#pause-icon').style['display']).toBe('');
			expect(media.smoothSeeks).toEqual([0, 0.12, 0]);
		});

		it.each(['retired', 'rejected'] as const)(
			'should preserve the latest error when an older %s seek settles', async (outcome) => {
				const player = await loadPlayer(smoothOptions);
				let release!: () => void;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				media.smoothSteps.push({ gate, retired: outcome === 'retired', reject: true,
					error: outcome === 'rejected' ? new Error('Retired failure') : undefined });
				try {
					key(player, 'ArrowRight');
					await settle();
					media.smoothSteps.push({ error: new Error('Current failure'), reject: true });
					key(player, 'ArrowLeft');
					await settle();
					expect(player.element('#error-element').textContent).toContain('Current failure');
					release();
					await settle();
					expect(player.element('#error-element').textContent).toContain('Current failure');
				} finally {
					release();
				}
			});

		it('should ignore M and hidden mute-button clicks when no audio track exists', async () => {
			const player = await loadPlayer(smoothOptions);
			player.tick();
			const before = player.element('#warning-element').textContent;
			key(player, 'KeyM');
			player.element('#volume-button').click();
			await settle();
			player.tick();
			expect(player.element('#volume-bar').style['width']).toBeUndefined();
			expect(player.element('#warning-element').textContent).toBe(before);
			expect(player.element('#error-element').textContent).toBe('');
			expect(media.audioContexts).toBe(0);
		});
	});

	describe('when muting ordinary audio/video playback', () => {
		it('should toggle volume through M and the volume button', async () => {
			const player = await loadPlayer();
			player.window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyM' }));
			expect(player.element('#volume-bar').style['width']).toBe('0%');
			player.element('#volume-button').click();
			expect(player.element('#volume-bar').style['width']).toBe('70%');
		});
	});

	describe('when requesting smooth playback with incompatible input or settings', () => {
		it.each([
			{ query: '?smooth=1&decodeWidth=120', message: 'cannot be combined' },
			{ query: '?smooth=1', message: 'minimumRequestSize' },
			{ codec: 'avc', audio: false, message: 'seekable HTJ2K' },
			{ codec: 'htj2k', audio: true, message: 'without audio' },
			{ codec: 'htj2k', audio: false, live: true, message: 'seekable HTJ2K' },
			{ codec: 'htj2k', audio: false, width: 720, message: '16:9' },
		])('should show an admission error for $message', async (options) => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const player = await loadPlayer({ query: '?smooth=1&minimumRequestSize=32768', ...options });
			expect(player.element('#error-element').textContent).toContain(options.message);
			expect(player.element('#player').style['display']).toBe('none');
			expect(media.draws).toEqual([]);
		});
	});

	describe('when video starts after audio', () => {
		it('should preview the first video frame on load and early seek without advancing the clock', async () => {
			const player = await loadPlayer({ videoStart: 0.08 });
			player.tick();
			expect(media.draws.at(-1)).toBe(0.08);
			expect(player.element('#current-time').textContent).toBe('00:00.000');
			player.window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowRight' }));
			await settle();
			expect(media.draws.at(-1)).toBe(0.12);
			player.window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowLeft' }));
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0.08);
			expect(player.element('#current-time').textContent).toBe('00:00.000');
			player.element('#play-button').click();
			await settle();
			expect(media.audioStarts).toEqual([0]);
		});
	});

	describe('when the final video frame arrives after the clock endpoint', () => {
		it('should present frames beyond an underestimated metadata duration without reporting a stall', async () => {
			const player = await loadPlayer({ finalVideoOffset: 0.16 });
			await player.start();
			media.clock = 0.13;
			player.tick();
			media.release();
			await settle();
			media.clock = 0.2;
			player.tick();
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0.16);
			expect(player.element('#current-time').textContent).toBe('00:00.120');
			expect(player.element('#progress-bar').style['width']).toBe('100%');
			expect(player.element('#play-icon').style['display']).toBe('');
			await vi.advanceTimersByTimeAsync(10000);
			expect(player.element('#error-element').textContent).toBe('');
		});

		it('should present the final frame before stopping at the duration', async () => {
			const player = await loadPlayer();
			await player.start();
			media.releaseAudio();
			await settle();
			media.clock = 0.2;
			player.tick();
			expect(player.element('#play-icon').style['display']).toBe('none');
			media.release();
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0.08);
			expect(player.element('#current-time').textContent).toBe('00:00.120');
			expect(player.element('#play-icon').style['display']).toBe('');
		});

		it('should retain the manually paused frame and not schedule late audio', async () => {
			const player = await loadPlayer();
			await player.start();
			player.element('#play-button').click();
			media.release();
			media.releaseAudio();
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0.04);
			expect(media.audioStarts).toEqual([0]);
		});

		it.each(['seek', 'load'] as const)('should discard endpoint work after a new %s', async (action) => {
			const player = await loadPlayer();
			await player.start();
			media.clock = 0.2;
			player.tick();
			const releaseOld = media.release;
			if (action === 'seek') {
				player.window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowLeft' }));
			} else {
				player.element('#load-url').click();
			}
			await settle();
			releaseOld();
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0);
		});

		it('should retire the old deadline when live metadata extends the endpoint', async () => {
			const player = await loadPlayer({ live: true });
			await player.start();
			media.clock = 0.2;
			player.tick();
			media.end = 20;
			await vi.advanceTimersByTimeAsync(1000);
			media.clock = 11;
			await vi.advanceTimersByTimeAsync(10000);
			player.tick();
			expect(player.element('#error-element').textContent).toBe('');
			expect(player.element('#play-icon').style['display']).toBe('none');
			media.release();
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0.08);
		});

		it('should report a stalled endpoint and prevent its eventual completion from drawing', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const player = await loadPlayer();
			await player.start();
			media.clock = 0.2;
			player.tick();
			await vi.advanceTimersByTimeAsync(9999);
			expect(player.element('#error-element').textContent).toBe('');
			await vi.advanceTimersByTimeAsync(1);
			expect(player.element('#error-element').textContent).toContain('Video did not finish within 10 seconds');
			media.release();
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0.04);
		});
	});

	describe('when paused previews overlap', () => {
		it('should keep queued playback pixels intact when retired previews finish converting', async () => {
			const player = await loadPlayer();
			let release = () => {};
			media.previewGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			for (const code of ['ArrowRight', 'ArrowLeft']) {
				player.window.dispatchEvent(Object.assign(new Event('keydown'), { code }));
				await settle();
			}
			media.previewGate = null;
			player.element('#play-button').click();
			await settle();
			release();
			await settle();
			media.clock = 0.04;
			player.tick();
			expect(media.draws.at(-1)).toBe(0.04);
		});

		it('should show a paused load and seek without waiting for sequential lookahead', async () => {
			const player = await loadPlayer({ lookaheadGate: new Promise<void>(() => {}) });
			expect(player.element('#player').style['display']).toBe('');
			expect(media.draws).toEqual([0]);
			player.window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowRight' }));
			await settle();
			expect(media.draws).toEqual([0, 0.12]);
		});

		it('should keep the latest seek visible after an older preview completes', async () => {
			const player = await loadPlayer();
			let release = () => {};
			media.previewGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			player.window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowRight' }));
			await settle();
			media.previewGate = null;
			player.window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowLeft' }));
			await settle();
			expect(media.draws.at(-1)).toBe(0);
			release();
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0);
		});
	});
});
