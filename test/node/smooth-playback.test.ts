import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import { CustomSource, Input, MXF, VideoSample } from '../../src/index.js';
import { SmoothPlayback } from '../../examples/media-player/smooth-playback.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

// Original CC0-1.0 960x540 RGB8 pattern: color bars, checkerboard and fine vertical detail, phase 0.
// OpenJPH 0.32.0, commit 23c422895ce6c3a156935222e4715ee0b7be952c: lossless RPCL, reversible MCT,
// four decompositions, one tile/tile-part/layer, precincts {128,128},{256,256}, 64x64 codeblocks.
// Synthetic MXF wrappers below repeat this real encoded frame; they are not camera-interoperability evidence.
const makeFile = () => {
	registerHtj2kDecoder();
	return makeIndexedMxf({ videoOnly: true, editRate: [24, 1], htj2k: {
		data: readFileSync(new URL('../public/htj2k-rpcl-960x540-8.j2c', import.meta.url)),
		bits: 8, width: 960, height: 540,
	} });
};
const until = async (condition: () => boolean) => {
	for (let i = 0; i < 2000; i++) {
		if (condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 1));
	}
	throw new Error('Playback did not settle.');
};

const heldPlayback = async () => {
	const file = makeFile();
	let blocked: Promise<void> | undefined;
	let release: (() => void) | undefined;
	let held = 0;
	let minimumHeldBytes = 0;
	const input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
		read: async (start, end) => {
			if (blocked && end - start >= minimumHeldBytes) {
				held++;
				await blocked;
			}
			return file.read(start, end);
		}, maxCacheSize: 0 }) });
	const drawn: { timestamp: number; width: number }[] = [];
	const errors: unknown[] = [];
	const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
		sample => drawn.push({ timestamp: sample.timestamp, width: sample.codedWidth }), error => errors.push(error));
	const unblock = () => {
		blocked = undefined;
		release?.();
	};
	return {
		player, drawn, errors,
		block(minimumBytes = 0) {
			held = 0;
			minimumHeldBytes = minimumBytes;
			blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		waitForRead: () => until(() => held > 0),
		unblock,
		async dispose() {
			unblock();
			await player.dispose();
			input.dispose();
		},
	};
};

describe('given the smooth player and authored native HTJ2K essence', () => {
	describe('when pausing a non-frame-aligned seek while its preview read is pending', () => {
		it.each([false, true])('should establish a real preview before resuming, early Play=%s', async (earlyPlay) => {
			const fixture = await heldPlayback();
			const { player, errors, drawn } = fixture;
			try {
				await player.seek(0);
				fixture.block(16384);
				const seeking = player.seek(1.01, true);
				await fixture.waitForRead();
				player.pause();
				expect(player.wantsPlay).toBe(false);
				if (earlyPlay) {
					player.play();
				}
				expect(drawn).toEqual([{ timestamp: 0, width: 120 }]);
				fixture.unblock();
				await seeking;
				if (!earlyPlay) {
					expect(drawn).toEqual([{ timestamp: 0, width: 120 }, { timestamp: 1, width: 120 }]);
					expect(player.state).toBe('paused');
					player.play();
				}
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(performance.now() / 1000);
				expect(errors).toEqual([]);
				expect(player.state).toBe('playing');
				expect(drawn.slice(0, 2)).toEqual([{ timestamp: 0, width: 120 }, { timestamp: 1, width: 120 }]);
				expect(drawn.at(-1)).toEqual({ timestamp: 25 / 24, width: 120 });
			} finally {
				await fixture.dispose();
			}
		});
	});

	describe('when a startup intent is retired', () => {
		it.each(['pause', 'seek', 'dispose'] as const)('should renew grace on Play after %s', async (action) => {
			let clock = 100000;
			const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
			const fixture = await heldPlayback();
			const { player, errors, drawn } = fixture;
			try {
				await player.seek(0);
				fixture.block();
				player.play();
				await fixture.waitForRead();
				clock = 200000;
				const retiring = action === 'seek'
					? player.seek(1)
					: action === 'dispose' ? player.dispose() : player.pause();
				player.tick(200);
				fixture.unblock();
				await retiring;
				expect(player.wantsPlay).toBe(false);
				clock = 300000;
				fixture.block();
				player.play();
				await fixture.waitForRead();
				player.tick(305.9);
				fixture.unblock();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(306);
				expect(player.state).toBe('playing');
				expect(new Set(drawn.map(frame => frame.width))).toEqual(new Set([120]));
				expect(errors).toEqual([]);
			} finally {
				await fixture.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when a resumed seek spends its grace waiting for preview', () => {
		it.each([false, true])('should retain resume intent through seek completion, explicit=%s', async (resume) => {
			let clock = 100000;
			const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
			const fixture = await heldPlayback();
			const { player, errors, drawn } = fixture;
			try {
				await player.seek(0);
				fixture.block();
				const seeking = player.seek(1, resume);
				if (!resume) {
					player.play();
				}
				await fixture.waitForRead();
				clock = 107000;
				fixture.unblock();
				await seeking;
				fixture.block();
				await fixture.waitForRead();
				expect(player.bufferedSeconds).toBe(0);
				player.tick(107);
				fixture.unblock();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(108);
				expect(drawn.map(frame => frame.width)).toEqual([120, 120, 60]);
				expect(errors).toEqual([]);
			} finally {
				await fixture.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when readiness and a pending cold read cross the startup boundary', () => {
		it('should prefer readiness at the deadline and discard the cold partial rate batch', async () => {
			const file = makeFile();
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
					if (phase === 0) {
						clock += 100;
					}
					return file.read(start, end);
				}, maxCacheSize: 0 }) });
			const drawn: { timestamp: number; width: number }[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
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
				for (let i = 1; i <= 54; i++) {
					player.tick(now + i / 24);
				}
				expect(player.bufferedSeconds).toBeLessThan(0.5);
				limit = Infinity;
				release!();
				gate = undefined;
				for (let i = 55; i < 95; i++) {
					await until(() => player.bufferedSeconds >= 2.9 || errors.length > 0);
					player.tick(now + i / 24);
				}
				expect(new Set(drawn.map(frame => frame.width))).toEqual(new Set([120]));
				for (let i = 0; i < drawn.length; i++) {
					expect(drawn[i]!.timestamp).toBeCloseTo(i / 24, 7);
				}
				expect(errors).toEqual([]);
			} finally {
				release?.();
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when startup has no completed rate batch', () => {
		it.each([5.999, 6, 20])('should retain 120 until six seconds of Play intent, elapsed=%s', async (elapsed) => {
			const file = makeFile();
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
			const drawn: { timestamp: number; width: number }[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
				sample => drawn.push({ timestamp: sample.timestamp, width: sample.codedWidth }),
				error => errors.push(error));
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
				expect(drawn).toEqual([{ timestamp: 0, width: 120 },
					{ timestamp: 1 / 24, width: elapsed < 6 ? 120 : 60 }]);
				player.pause();
				player.play();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(122);
				expect(drawn.at(-1)).toEqual({ timestamp: 2 / 24, width: elapsed < 6 ? 120 : 60 });
			} finally {
				release?.();
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when a quality upgrade restarts production with a full queue', () => {
		it('should wait for capacity and keep all displayed timestamps consecutive', async () => {
			const file = makeFile();
			const time = vi.spyOn(performance, 'now').mockReturnValue(0);
			using input = new Input({ formats: [MXF], source: new CustomSource({
				getSize: () => file.size, read: file.read }) });
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
				player.tick(5.001);
				await new Promise(resolve => setTimeout(resolve, 10));
				expect(errors).toEqual([]);
				for (let i = 1; i <= 80; i++) {
					player.tick(4.99 + i / 24);
					await full();
				}
				expect(drawn.some(frame => frame.width === 240)).toBe(true);
				for (let i = 0; i < drawn.length; i++) {
					expect(drawn[i]!.timestamp).toBeCloseTo(i / 24, 7);
				}
				expect(errors).toEqual([]);
			} finally {
				await player.dispose();
				time.mockRestore();
			}
		});
	});

	describe('when playback starves or a pending refinement is retired', () => {
		it('should freeze, resume consecutively, discard stale work and refine the paused timestamp', async () => {
			const file = makeFile();
			let blocked: Promise<void> | null = null;
			let unblock: (() => void) | undefined;
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: async (start, end) => {
					await blocked;
					return file.read(start, end);
				}, maxCacheSize: 0 }) });
			const drawn: { timestamp: number; sample: VideoSample }[] = [];
			const errors: unknown[] = [];
			const player = new SmoothPlayback((await input.getPrimaryVideoTrack())!,
				sample => drawn.push({ timestamp: sample.timestamp, sample }), error => errors.push(error));
			try {
				await player.seek(0);
				player.play();
				await until(() => player.bufferedSeconds >= 3 - 1e-7 || errors.length > 0);
				expect(errors).toEqual([]);
				expect(player.ownedBytes).toBe(72 * 120 * 68 * 4);
				blocked = new Promise<void>((resolve) => {
					unblock = resolve;
				});
				for (let now = 0; now < 4; now += 1 / 24) {
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
				await player.seek(3.01, true);
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
			for (const { sample } of drawn) {
				expect(() => sample.allocationSize()).toThrow();
			}
		});
	});

	describe('when seeking outside available samples and replaying', () => {
		it('should discard stale timestamps and drain a short EOF tail', async () => {
			const file = makeFile();
			using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
				read: file.read }) });
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
				for (let i = 0; i < 5; i++) {
					player.tick(i / 24);
				}
				expect(player.state).toBe('ended');
				expect(drawn.slice(1)).toEqual([9997 / 24, 9998 / 24, 9999 / 24]);
				await player.seek(0);
				player.play();
				await until(() => player.bufferedSeconds >= 2 || errors.length > 0);
				player.tick(10);
				expect(player.timestamp).toBeCloseTo(1 / 24, 7);
				expect(errors).toEqual([]);
			} finally {
				await player.dispose();
			}
		});
	});
});
