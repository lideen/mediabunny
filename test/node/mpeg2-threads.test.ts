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
			expect(() => registerMpeg2Decoder({ threadedRuntimeUrl: 'https://example.invalid/runtime.mjs' }))
				.toThrow('threadCount 2 or 4');
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
		it.each(['Worker', 'isolation', 'SharedArrayBuffer', 'runtime'] as const)(
			'should reject missing %s through the public sink without scalar fallback', async (missing) => {
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
				registerMpeg2Decoder({ threadCount: 2 });
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
