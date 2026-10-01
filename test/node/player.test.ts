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
	previewGate: null as Promise<void> | null,
	lookaheadGate: null as Promise<void> | null,
}));
vi.mock('@mediabunny/ac3', () => ({ registerAc3Decoder: () => {} }));
vi.mock('@mediabunny/dts', () => ({ registerDtsDecoder: () => {} }));
vi.mock('@mediabunny/prores', () => ({ registerProresDecoder: () => {} }));
vi.mock('mediabunny', async (original) => {
	const metadata = {
		isRelativeToUnixEpoch: () => false,
		getLiveRefreshInterval: () => media.live ? 1 : null,
		isLive: () => media.live,
	};
	const videoTrack = {
		...metadata, getCodec: () => 'avc', canDecode: () => true,
		getFirstTimestamp: () => media.videoStart,
		getDisplayWidth: () => 16, getDisplayHeight: () => 16, canBeTransparent: () => false,
	};
	const audioTrack = {
		...metadata, getCodec: () => 'aac', canDecode: () => true, getSampleRate: () => 48000,
	};
	return {
		...await original<object>(),
		Input: class {
			getPrimaryVideoTrack() { return videoTrack; }
			getPrimaryAudioTrack() { return audioTrack; }
			getFirstTimestamp() { return 0; }
			getDurationFromMetadata() { return media.end; }
			dispose() {}
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
}: {
	live?: boolean;
	lookaheadGate?: Promise<void> | null;
	videoStart?: number;
	finalVideoOffset?: number;
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
