import { describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CustomSource, Input, MXF, VideoSample } from '../../src/index.js';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import { SmoothPlayback } from '../../examples/media-player/smooth-playback.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';
import { extractReduced } from '../../packages/htj2k/src/reduced.js';
import { makeColdInput } from './smooth-cold-fixture.js';

const evidence = process.env['HTJ2K_EVIDENCE'];
const until = async (condition: () => boolean) => {
	for (let i = 0; i < 2000; i++) {
		if (condition()) return;
		await new Promise(resolve => setTimeout(resolve, 1));
	}
	throw new Error('Playback did not settle.');
};

describe.skipIf(!evidence)('given the example smooth player and retained HTJ2K essence', () => {
	it.skipIf(!process.env['HTJ2K_SMOOTH_ORACLES'])(
		'should render beyond its startup buffer under per-frame cold-cache latency without serial metadata stalls',
		async () => {
			const fixture = await makeColdInput(evidence!);
			const input = fixture.input;
			const drawn: { timestamp: number; wall: number; width: number; height: number; buffered: number }[] = [];
			const samples = new Map<number, VideoSample>();
			const errors: unknown[] = [];
			const states = new Set<string>();
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!, (sample) => {
				drawn.push({ timestamp: sample.timestamp, wall: performance.now(), width: sample.codedWidth,
					height: sample.codedHeight, buffered: player.bufferedSeconds });
				if (!samples.has(sample.codedWidth)) samples.set(sample.codedWidth, sample.clone());
			}, error => errors.push(error));
			let timer: ReturnType<typeof setInterval> | undefined;
			let started = 0;
			try {
				await player.seek(0);
				drawn.length = 0;
				started = performance.now();
				player.play();
				timer = setInterval(() => {
					player.tick(performance.now() / 1000);
					if (drawn.length) states.add(player.state);
				}, 4);
				const deadline = started + 14000;
				while (drawn.length < 121 && errors.length === 0 && performance.now() < deadline) {
					await new Promise(resolve => setTimeout(resolve, 10));
				}
				expect(errors).toEqual([]);
				expect(drawn.length).toBeGreaterThanOrEqual(121);
				expect(drawn[0]!.wall - started).toBeLessThan(7000);
				expect(drawn[0]!.buffered).toBeLessThanOrEqual(3);
				expect(states.has('buffering')).toBe(false);
				expect(drawn[120]!.wall - drawn[0]!.wall).toBeLessThan(5300);
				for (let i = 0; i < 121; i++) expect(drawn[i]!.timestamp).toBeCloseTo((i + 1) / 24, 7);
				expect(fixture.peakRequests).toBeLessThanOrEqual(48);
				expect(fixture.peakPayloads).toBeLessThanOrEqual(48);
				expect(player.ownedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
				const { frames } = JSON.parse(readFileSync(process.env['HTJ2K_SMOOTH_ORACLES']!, 'utf8')) as {
					frames: { originalFrameIndex: number; width: number; outputs: { rgba8: { sha256: string } } }[];
				};
				for (const sample of samples.values()) {
					const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
					await sample.copyTo(rgba, { format: 'RGBA' });
					const oracle = frames.find(frame => frame.originalFrameIndex === 0
						&& frame.width === sample.codedWidth)!;
					expect(createHash('sha256').update(rgba).digest('hex')).toBe(oracle.outputs.rgba8.sha256);
				}
			} finally {
				clearInterval(timer);
				await player.dispose();
				input.dispose();
				await fixture.drain();
				for (const sample of samples.values()) sample.close();
				const report = { fixture: 'Repeated frame 0; per-frame 1300 ms cold / 20 ms warm ranges',
					started, drawn, requests: fixture.requests, peakRequests: fixture.peakRequests,
					peakPayloads: fixture.peakPayloads, states: [...states], errors: errors.map(String) };
				if (process.env['HTJ2K_COLD_TRACE']) {
					writeFileSync(process.env['HTJ2K_COLD_TRACE'], JSON.stringify(report, null, 2));
				}
				console.log('Cold-cache local playback', { frames: drawn.length,
					startupMs: drawn[0] ? drawn[0].wall - started : null,
					spanMs: drawn[120] ? drawn[120].wall - drawn[0]!.wall : null,
					peakRequests: fixture.peakRequests, peakPayloads: fixture.peakPayloads, states: [...states] });
			}
		}, 20000,
	);

	const makeFile = async () => {
		registerHtj2kDecoder();
		const source = new Uint8Array(readFileSync(`${evidence}/firstframe.jph`));
		const derived = await extractReduced({ byteLength: source.length,
			read: async (start, end) => source.slice(start, end),
		}, { width: 480, height: 270 }, { width: 3840, height: 2160, bits: 16 });
		return makeIndexedMxf({ htj2k: { data: derived.data,
			bits: 16, width: 3840, height: 2160 }, editRate: [24, 1] });
	};

	describe('when startup production is slower than real time', () => {
		it.each([2.1, 6])('should defer rate-based fallback until the deadline, elapsed=%s', async (elapsed) => {
			const file = await makeFile();
			let clock = 0;
			const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
			let release: (() => void) | undefined;
			let gate: Promise<void> | undefined;
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: async (start, end) => {
					await gate;
					clock += 100;
					return file.read(start, end);
				}, maxCacheSize: 0 }) });
			const drawn: { timestamp: number; width: number }[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
				sample => drawn.push({ timestamp: sample.timestamp, width: sample.codedWidth }),
				error => errors.push(error));
			try {
				await player.seek(0);
				player.play();
				const intent = clock / 1000;
				// Yield to the controller at each admitted frame, before it can fill one second.
				const originalRead = file.read;
				file.read = (start, end) => {
					if (player.bufferedSeconds >= 0.55 && !gate) {
						gate = new Promise<void>((resolve) => {
							release = resolve;
						});
					}
					return originalRead(start, end);
				};
				await until(() => player.bufferedSeconds >= 0.55 || errors.length > 0);
				player.tick(intent + elapsed);
				expect(player.state).toBe('starting');
				release?.();
				file.read = originalRead;
				gate = undefined;
				await until(() => player.bufferedSeconds >= 1.9 || errors.length > 0);
				for (let i = 0; i < 40; i++) player.tick(intent + 7 + i / 24);
				expect(errors).toEqual([]);
				expect(drawn.some(frame => frame.width === 60)).toBe(elapsed >= 6);
				for (let i = 0; i < drawn.length; i++) expect(drawn[i]!.timestamp).toBeCloseTo(i / 24, 7);
			} finally {
				release?.();
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when initial playback has not produced a rate batch', () => {
		it.each([5.999, 6, 20])('should protect 120 until six seconds of Play intent, elapsed=%s', async (elapsed) => {
			const file = await makeFile();
			const time = vi.spyOn(performance, 'now').mockReturnValue(100000);
			let release!: () => void;
			let blocked: Promise<void> | undefined;
			let held = 0;
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: async (start, end) => {
					if (blocked) {
						held++;
						await blocked;
					}
					return file.read(start, end);
				}, maxCacheSize: 0 }) });
			const drawn: number[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
				sample => drawn.push(sample.codedWidth), error => errors.push(error));
			try {
				await player.seek(0);
				blocked = new Promise<void>((resolve) => {
					release = resolve;
				});
				player.play();
				await until(() => held > 0);
				expect(player.bufferedSeconds).toBe(0);
				player.tick(100 + elapsed);
				player.tick(100 + elapsed + 0.0001);
				blocked = undefined;
				release();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(121);
				expect(errors).toEqual([]);
				expect(drawn).toEqual([120, elapsed < 6 ? 120 : 60]);
				player.pause();
				player.play();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(122);
				expect(drawn.at(-1)).toBe(elapsed < 6 ? 120 : 60);
			} finally {
				release?.();
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when readiness and a pending cold read cross the startup boundary', () => {
		it('should prefer readiness at the deadline and discard the cold partial rate batch', async () => {
			const file = await makeFile();
			let clock = 100000;
			const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
			let release: (() => void) | undefined;
			let gate: Promise<void> | undefined;
			let limit = 2;
			let phase = 0;
			let measuring = false;
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: async (start, end) => {
					if (measuring && player.bufferedSeconds >= limit - 1e-7 && !gate) {
						gate = new Promise<void>((resolve) => {
							release = resolve;
						});
						phase++;
					}
					await gate;
					if (phase === 0) clock += 100;
					return file.read(start, end);
				}, maxCacheSize: 0 }) });
			const drawn: { timestamp: number; width: number }[] = [];
			const errors: unknown[] = [];
			const track = (await input.getPrimaryVideoTrack())!;
			const player = new SmoothPlayback(track,
				sample => drawn.push({ timestamp: sample.timestamp, width: sample.codedWidth }),
				error => errors.push(error));
			try {
				await player.seek(0);
				measuring = true;
				player.play();
				await until(() => phase === 1);
				const now = clock / 1000 + 6;
				player.tick(now);
				expect(player.state).toBe('playing');
				clock += 100000;
				limit = 2.6;
				release!();
				gate = undefined;
				await until(() => phase === 2);
				// Drain below the steady-state downgrade floor with the new production batch established.
				for (let i = 1; i <= 54; i++) player.tick(now + i / 24);
				expect(player.bufferedSeconds).toBeLessThan(0.5);
				limit = Infinity;
				release!();
				gate = undefined;
				for (let i = 55; i < 95; i++) {
					await until(() => player.bufferedSeconds >= 2.9 || errors.length > 0);
					player.tick(now + i / 24);
				}
				expect(errors).toEqual([]);
				expect(new Set(drawn.map(frame => frame.width))).toEqual(new Set([120]));
				for (let i = 0; i < drawn.length; i++) expect(drawn[i]!.timestamp).toBeCloseTo(i / 24, 7);
			} finally {
				release?.();
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when a startup intent is retired', () => {
		it.each(['pause', 'seek', 'dispose'] as const)('should renew grace on Play after %s', async (action) => {
			const file = await makeFile();
			let clock = 100000;
			const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
			let blocked: Promise<void> | undefined;
			let release: (() => void) | undefined;
			let held = 0;
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: async (start, end) => {
					if (blocked) {
						held++;
						await blocked;
					}
					return file.read(start, end);
				}, maxCacheSize: 0 }) });
			const drawn: number[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
				sample => drawn.push(sample.codedWidth), error => errors.push(error));
			try {
				await player.seek(0);
				blocked = new Promise<void>((resolve) => {
					release = resolve;
				});
				player.play();
				await until(() => held > 0);
				clock = 200000;
				const retiring = action === 'seek'
					? player.seek(1)
					: action === 'dispose' ? player.dispose() : player.pause();
				player.tick(200);
				blocked = undefined;
				release!();
				await retiring;
				expect(player.wantsPlay).toBe(false);
				clock = 300000;
				held = 0;
				blocked = new Promise<void>((resolve) => {
					release = resolve;
				});
				player.play();
				await until(() => held > 0);
				player.tick(305.9);
				blocked = undefined;
				release!();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(306);
				expect(player.state).toBe('playing');
				expect(new Set(drawn)).toEqual(new Set([120]));
				expect(errors).toEqual([]);
			} finally {
				release?.();
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when a resumed seek spends its grace waiting for preview', () => {
		it.each([false, true])('should retain resume intent through seek completion, explicit=%s', async (resume) => {
			const file = await makeFile();
			let clock = 100000;
			const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
			let blocked: Promise<void> | undefined;
			let release: (() => void) | undefined;
			let held = 0;
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: async (start, end) => {
					if (blocked) {
						held++;
						await blocked;
					}
					return file.read(start, end);
				}, maxCacheSize: 0 }) });
			const widths: number[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
				sample => widths.push(sample.codedWidth), error => errors.push(error));
			try {
				await player.seek(0);
				blocked = new Promise<void>((resolve) => {
					release = resolve;
				});
				const seeking = player.seek(1, resume);
				if (!resume) player.play();
				await until(() => held > 0);
				clock = 107000;
				blocked = undefined;
				release!();
				await seeking;
				held = 0;
				blocked = new Promise<void>((resolve) => {
					release = resolve;
				});
				await until(() => held > 0);
				expect(player.bufferedSeconds).toBe(0);
				player.tick(107);
				blocked = undefined;
				release!();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(108);
				expect(widths).toEqual([120, 120, 60]);
				expect(errors).toEqual([]);
			} finally {
				release?.();
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when a quality upgrade restarts production with a full decoded queue', () => {
		it('should wait for display capacity before requesting the next metadata entry', async () => {
			const file = await makeFile();
			const time = vi.spyOn(performance, 'now').mockReturnValue(0);
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => file.size, read: file.read,
			}) });
			const drawn: { timestamp: number; width: number }[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
				sample => drawn.push({ timestamp: sample.timestamp, width: sample.codedWidth }),
				error => errors.push(error));
			const full = () => until(() => player.bufferedSeconds >= 3 - 1e-7 || errors.length > 0);
			try {
				await player.seek(0);
				player.play();
				await full();
				player.tick(0);
				await full();
				for (let i = 1; i <= 14; i++) {
					player.tick(i / 24);
					await full();
				}
				player.tick(4.99);
				await full();
				// Cross the five-second upgrade threshold between render deadlines, with no capacity freed.
				player.tick(5.001);
				await new Promise(resolve => setTimeout(resolve, 10));
				expect(errors).toEqual([]);
				for (let i = 1; i <= 80; i++) {
					player.tick(4.99 + i / 24);
					await full();
				}
				expect(drawn.some(frame => frame.width === 240)).toBe(true);
				for (let i = 0; i < drawn.length; i++) expect(drawn[i]!.timestamp).toBeCloseTo(i / 24, 7);
				expect(errors).toEqual([]);
			} finally {
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when seeking outside the available samples and replaying', () => {
		it('should not resume stale timestamps after an empty seek and should drain a short EOF tail', async () => {
			const file = await makeFile();
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: file.read, maxCacheSize: 0 }) });
			const drawn: number[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
				sample => drawn.push(sample.timestamp), error => errors.push(error));
			try {
				await player.seek(1);
				await player.seek(-1, true);
				expect(player.timestamp).toBe(-1);
				expect(player.state).toBe('ended');
				expect(player.bufferedSeconds).toBe(0);
				expect(drawn).toEqual([1]);
				await player.seek((file.count - 3) / 24, true);
				await until(() => player.bufferedSeconds >= 2 / 24 - 1e-7 || errors.length > 0);
				await new Promise(resolve => setTimeout(resolve, 10));
				for (let i = 0; i < 5; i++) player.tick(i / 24);
				expect(player.state).toBe('ended');
				expect(drawn.slice(1)).toEqual([9997 / 24, 9998 / 24, 9999 / 24]);
				await player.seek(0);
				player.play();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(10);
				expect(player.timestamp).toBeCloseTo(1 / 24, 7);
				expect(errors).toEqual([]);
			} finally { await player.dispose(); }
		});
	});

	it('should freeze on starvation, resume consecutively, and never catch up by dropping samples', async () => {
		const file = await makeFile();
		let blocked: Promise<void> | null = null;
		let unblock: (() => void) | undefined;
		using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
			read: async (start, end) => {
				await blocked;
				return file.read(start, end);
			}, maxCacheSize: 0 }) });
		const track = (await input.getPrimaryVideoTrack())!;
		const drawn: { timestamp: number; sample: VideoSample }[] = [];
		const errors: unknown[] = [];
		const player = new SmoothPlayback(track, sample => drawn.push({ timestamp: sample.timestamp, sample }),
			error => errors.push(error));
		try {
			await player.seek(0);
			player.play();
			await until(() => player.bufferedSeconds >= 3 - 1e-7 || errors.length > 0);
			expect(errors).toEqual([]);
			expect(player.state).toBe('starting');
			expect(player.ownedBytes).toBe(72 * 120 * 68 * 4);
			blocked = new Promise<void>((resolve) => {
				unblock = resolve;
			});
			let now = 0;
			for (; now < 4; now += 1 / 24) {
				player.tick(now);
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			expect(player.state).toBe('buffering');
			expect(player.ownedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
			const stalled = player.timestamp;
			player.tick(20);
			expect(player.timestamp).toBe(stalled);
			unblock!();
			blocked = null;
			await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
			player.tick(21);
			expect(player.state).toBe('playing');
			const beforeLate = drawn.length;
			player.tick(40);
			expect(drawn.length).toBe(beforeLate + 1);
			expect(player.lateness).toBeGreaterThan(1);
			for (let i = 1; i < drawn.length; i++) {
				expect(drawn[i]!.timestamp).toBeCloseTo(i / 24, 7);
			}
			expect(errors).toEqual([]);
			player.pause();
			const pausedAt = player.timestamp;
			const pauseDraws = drawn.length;
			blocked = new Promise<void>((resolve) => {
				unblock = resolve;
			});
			await until(() => player.refining);
			player.play();
			unblock!();
			blocked = null;
			await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
			expect(drawn.length).toBe(pauseDraws);
			expect(player.timestamp).toBe(pausedAt);
			player.tick(41);
			expect(player.timestamp).toBeCloseTo(pausedAt + 1 / 24, 7);
			expect(errors).toEqual([]);
			player.pause();
			blocked = new Promise<void>((resolve) => {
				unblock = resolve;
			});
			await until(() => player.refining);
			expect(player.ownedBytes).toBe(480 * 270 * 4);
			const beforeSeek = drawn.length;
			const seeking = player.seek(2.5);
			unblock!();
			blocked = null;
			await seeking;
			expect(drawn.length).toBe(beforeSeek + 1);
			expect(player.timestamp).toBe(2.5);
			blocked = new Promise<void>((resolve) => {
				unblock = resolve;
			});
			const seekWhilePlaying = player.seek(3.01);
			player.play();
			unblock!();
			blocked = null;
			await seekWhilePlaying;
			await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
			player.tick(42);
			expect(player.timestamp).toBeCloseTo(3 + 1 / 24, 7);
			player.pause();
			const refineAt = player.timestamp;
			await until(() => player.resolution === '480×270' || errors.length > 0);
			expect(player.timestamp).toBe(refineAt);
			expect(player.state).toBe('paused');
			expect(errors).toEqual([]);
		} finally {
			unblock?.();
			await player.dispose();
		}
		expect(player.ownedBytes).toBe(0);
		for (const { sample } of drawn) expect(() => sample.allocationSize()).toThrow();
	}, 30000);
});
