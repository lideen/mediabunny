import { afterEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({
	clock: 0, release: () => {}, draws: [] as number[], end: 0.12, live: false,
}));
vi.mock('@mediabunny/ac3', () => ({ registerAc3Decoder: () => {} }));
vi.mock('@mediabunny/dts', () => ({ registerDtsDecoder: () => {} }));
vi.mock('@mediabunny/prores', () => ({ registerProresDecoder: () => {} }));
vi.mock('@mediabunny/htj2k', () => ({ registerHtj2kDecoder: () => {} }));
vi.mock('@mediabunny/mpeg2', () => ({ registerMpeg2Decoder: () => {} }));
vi.mock('mediabunny', async (original) => {
	const track = {
		getCodec: () => 'mpeg2', canDecode: () => true, getSampleRate: () => 48000,
		isRelativeToUnixEpoch: () => false, getDisplayWidth: () => 16, getDisplayHeight: () => 16,
		canBeTransparent: () => false, getLiveRefreshInterval: () => media.live ? 1 : null,
		isLive: () => media.live,
	};
	return {
		...await original<object>(),
		Input: class {
			getPrimaryVideoTrack() { return track; }
			getPrimaryAudioTrack() { return track; }
			getFirstTimestamp() { return 0; }
			getDurationFromMetadata() { return media.end; }
			dispose() {}
		},
		CanvasSink: class {
			getCanvas(timestamp: number) { return { timestamp, canvas: timestamp }; }
			async* canvases() {
				yield { timestamp: 0, canvas: 0 };
				yield { timestamp: 0.04, canvas: 0.04 };
				await new Promise<void>((resolve) => {
					media.release = resolve;
				});
				yield { timestamp: 0.08, canvas: 0.08 };
			}
		},
		AudioBufferSink: class {
			async* buffers() {
				// Audio ends one 25 fps interval before video.
				yield { timestamp: 0, buffer: { duration: 0.08 } };
			}
		},
	};
});

class Element extends EventTarget {
	style: Record<string, string> = {};
	textContent = '';
	children: Element[] = [];
	getContext() {
		return { clearRect: () => {}, drawImage: (frame: number) => media.draws.push(frame) };
	}

	click() { this.dispatchEvent(new Event('click')); }
}

const settle = async () => {
	for (let i = 0; i < 100; i++) await Promise.resolve();
};

const loadPlayer = async (live = false) => {
	vi.resetModules();
	vi.useFakeTimers();
	media.clock = 0;
	media.draws = [];
	media.end = 0.12;
	media.live = live;
	const elements = new Map<string, Element>();
	const element = (selector: string) => {
		if (!elements.has(selector)) elements.set(selector, new Element());
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
			createBufferSource() { return { connect: () => {}, start: () => {}, stop: () => {} }; }
			async close() {}
		},
	});
	vi.stubGlobal('window', window);
	vi.stubGlobal('document', Object.assign(new EventTarget(), { querySelector: element }));
	vi.stubGlobal('location', { search: '' });
	vi.stubGlobal('prompt', () => 'https://example.invalid/authored');
	let render = () => {};
	vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
		render = callback;
	});
	await import('../../examples/media-player/media-player.js');
	element('#load-url').click();
	await settle();
	element('#play-button').click();
	await settle();
	media.clock = 0.04;
	render();
	await settle();
	return { element, window, tick: () => render() };
};

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('given the default player with a delayed final video frame and shorter audio', () => {
	it('should retain the final frame when decoding finishes after the natural clock endpoint', async () => {
		const player = await loadPlayer();
		media.clock = 0.2;
		player.tick();
		media.release();
		await settle();
		player.tick();
		expect(media.draws.at(-1)).toBe(0.08);
		expect(player.element('#current-time').textContent).toBe('00:00.120');
		expect(player.element('#play-icon').style['display']).toBe('');
	});

	it('should keep a manually paused frame instead of finishing the old video generation', async () => {
		const player = await loadPlayer();
		player.element('#play-button').click();
		media.release();
		await settle();
		player.tick();
		expect(media.draws.at(-1)).toBe(0.04);
	});

	it('should discard a pending endpoint frame after a seek and replay', async () => {
		const player = await loadPlayer();
		media.clock = 0.2;
		player.tick();
		const releaseOld = media.release;
		player.window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowLeft' }));
		await settle();
		releaseOld();
		await settle();
		player.tick();
		expect(media.draws.at(-1)).toBe(0);
	});

	it('should discard pending endpoint work when loading another input', async () => {
		const player = await loadPlayer();
		media.clock = 0.2;
		player.tick();
		const releaseOld = media.release;
		player.element('#load-url').click();
		await settle();
		releaseOld();
		await settle();
		player.tick();
		expect(media.draws.at(-1)).toBe(0);
	});

	it('should abandon the old EOF deadline when live metadata extends the endpoint', async () => {
		const player = await loadPlayer(true);
		media.clock = 0.2;
		player.tick();
		media.end = 20;
		await vi.advanceTimersByTimeAsync(1000);
		media.release();
		await settle();
		media.clock = 11;
		await vi.advanceTimersByTimeAsync(10000);
		player.tick();
		expect(media.draws.at(-1)).toBe(0.08);
		expect(player.element('#error-element').textContent).toBe('');
		expect(player.element('#play-icon').style['display']).toBe('none');
	});

	it('should report a stalled endpoint and prevent its eventual completion from drawing', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const player = await loadPlayer();
			media.clock = 0.2;
			player.tick();
			await vi.advanceTimersByTimeAsync(10000);
			expect(player.element('#error-element').textContent).toContain('Video did not finish within 10 seconds');
			media.release();
			await settle();
			player.tick();
			expect(media.draws.at(-1)).toBe(0.04);
		} finally {
			error.mockRestore();
		}
	});
});
