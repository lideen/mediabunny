import { afterEach, describe, expect, it, vi } from 'vitest';
import { lxfFixture } from './lxf-fixture.js';

afterEach(() => vi.unstubAllGlobals());

describe('given explicit MPEG-2 slice-thread options', () => {
	describe('when choosing the registration mode', () => {
		it('should reject contradictory or unsupported options before registering', async () => {
			vi.resetModules();
			const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
			expect(() => registerMpeg2Decoder({ threadCount: 2, useWorker: false })).toThrow('worker mode');
			// @ts-expect-error Runtime callers can supply unsupported pool sizes.
			expect(() => registerMpeg2Decoder({ threadCount: 3 })).toThrow('1, 2 or 4');
			expect(() => registerMpeg2Decoder({ threadCount: 1, threadedRuntimeUrl: '/relative/runtime.mjs' }))
				.toThrow();
			registerMpeg2Decoder();
			registerMpeg2Decoder({ threadCount: 1, useWorker: false });
		});

		it('should normalize implicit worker mode but reject a changed pool or runtime', async () => {
			vi.resetModules();
			const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
			const url = 'https://example.invalid/threads/js/threaded-runtime.mjs';
			registerMpeg2Decoder({ threadCount: 2, threadedRuntimeUrl: url });
			registerMpeg2Decoder({ threadCount: 2, useWorker: true, threadedRuntimeUrl: new URL(url) });
			expect(() => registerMpeg2Decoder({ threadCount: 4, threadedRuntimeUrl: url })).toThrow('different mode');
			expect(() => registerMpeg2Decoder({ threadCount: 2, threadedRuntimeUrl: `${url}?v=2` }))
				.toThrow('different mode');
			expect(() => registerMpeg2Decoder()).toThrow('different mode');
		});
	});

	describe('when a requested parallel backend is unavailable', () => {
		it.each([
			[2, 'Worker'], [2, 'isolation'], [2, 'SharedArrayBuffer'], [2, 'runtime'],
			[4, 'Worker'], [4, 'isolation'], [4, 'SharedArrayBuffer'], [4, 'runtime'],
		] as const)(
			'should reject explicit %s with missing %s without scalar fallback', async (threadCount, missing) => {
				vi.resetModules();
				vi.stubGlobal('Worker', missing === 'Worker'
					? undefined
					: class {
						constructor() { throw new Error('Unexpected worker construction'); }
					});
				vi.stubGlobal('crossOriginIsolated', missing !== 'isolation');
				if (missing === 'SharedArrayBuffer') vi.stubGlobal('SharedArrayBuffer', undefined);
				const core = await import('../../src/index.js');
				const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
				registerMpeg2Decoder({ threadCount });
				const fixture = lxfFixture(6);
				const input = new core.Input({ formats: [core.LXF],
					source: new core.BufferSource(fixture.read(0, fixture.size)) });
				try {
					const track = await input.getPrimaryVideoTrack();
					const sink = new core.VideoSampleSink(track!);
					await expect(sink.getSample(0)).rejects.toThrow(missing === 'Worker'
						? 'Worker'
						: missing === 'runtime' ? 'threadedRuntimeUrl' : 'crossOriginIsolated');
				} finally {
					input.dispose();
				}
			},
		);
	});
});

const runtimeUrl = 'https://example.invalid/threads/js/threaded-runtime.mjs';
const browser = (hardwareConcurrency: unknown = 8) => {
	vi.stubGlobal('navigator', { hardwareConcurrency });
	vi.stubGlobal('crossOriginIsolated', true);
	vi.stubGlobal('Worker', class {
		constructor() { throw new Error('Unexpected worker construction'); }
	});
};

describe('given automatic MPEG-2 pool sizing with a runtime URL', () => {
	describe('when the browser reports logical availability', () => {
		it.each([
			[1, 1], [2, 1], [3, 2], [4, 2], [5, 4], [6, 4], [64, 4],
			[undefined, 1], [null, 1], [0, 1], [-1, 1], [3.5, 1], [NaN, 1], [Infinity, 1], ['8', 1],
		] as const)('should normalize concurrency %s to an explicit %s-thread registration', async (hint, expected) => {
			vi.resetModules();
			browser();
			vi.stubGlobal('navigator', { hardwareConcurrency: hint });
			const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
			registerMpeg2Decoder({ threadedRuntimeUrl: runtimeUrl });
			registerMpeg2Decoder({ threadCount: expected, useWorker: expected > 1,
				threadedRuntimeUrl: new URL('https://example.invalid/threads/js/./threaded-runtime.mjs') });
			expect(() => registerMpeg2Decoder({ threadCount: expected === 4 ? 2 : 4,
				threadedRuntimeUrl: runtimeUrl })).toThrow('different mode');
		});
	});

	describe('when a prerequisite is unavailable', () => {
		it.each(['navigator', 'isolation', 'Worker', 'SharedArrayBuffer'] as const)(
			'should choose direct decoding without %s', async (missing) => {
				vi.resetModules();
				browser();
				vi.stubGlobal(missing === 'isolation' ? 'crossOriginIsolated' : missing,
					missing === 'isolation' ? false : undefined);
				const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
				registerMpeg2Decoder({ threadedRuntimeUrl: runtimeUrl });
				registerMpeg2Decoder({ threadCount: 1, useWorker: false, threadedRuntimeUrl: runtimeUrl });
			},
		);
	});

	describe('when the caller overrides automatic selection', () => {
		it.each([1, 2, 4] as const)('should honor explicit %s threads over the hint', async (threadCount) => {
			vi.resetModules();
			browser(threadCount === 4 ? 1 : 16);
			const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
			registerMpeg2Decoder({ threadCount, threadedRuntimeUrl: runtimeUrl });
			registerMpeg2Decoder({ threadCount, useWorker: threadCount > 1, threadedRuntimeUrl: runtimeUrl });
			expect(() => registerMpeg2Decoder({ threadedRuntimeUrl: runtimeUrl })).toThrow('different mode');
		});

		it('should suppress pooling when worker mode is explicitly disabled', async () => {
			vi.resetModules();
			browser();
			const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
			registerMpeg2Decoder({ useWorker: false, threadedRuntimeUrl: runtimeUrl });
			registerMpeg2Decoder({ threadCount: 1, useWorker: false, threadedRuntimeUrl: runtimeUrl });
			expect(() => registerMpeg2Decoder({ threadedRuntimeUrl: runtimeUrl })).toThrow('different mode');
		});

		it('should preserve serial worker mode when automatic selection is one', async () => {
			vi.resetModules();
			browser(2);
			const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
			registerMpeg2Decoder({ useWorker: true, threadedRuntimeUrl: runtimeUrl });
			registerMpeg2Decoder({ threadCount: 1, useWorker: true, threadedRuntimeUrl: runtimeUrl });
			expect(() => registerMpeg2Decoder({ threadedRuntimeUrl: runtimeUrl })).toThrow('different mode');
		});

		it('should preserve direct registration without a runtime even on an isolated many-core browser', async () => {
			vi.resetModules();
			browser(64);
			const { registerMpeg2Decoder } = await import('@mediabunny/mpeg2');
			registerMpeg2Decoder();
			registerMpeg2Decoder({ threadCount: 1, useWorker: false });
		});
	});
});
