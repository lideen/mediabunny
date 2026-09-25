import { readFileSync } from 'node:fs';
import { Input, MXF, UrlSource } from '../../src/index.js';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';
import { extractReduced } from '../../packages/htj2k/src/reduced.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

/** Each frame's first range waits for a 1.3 s cache fill; subsequent ranges take 20 ms. No external fetches. */
export const makeColdInput = async (evidence: string) => {
	registerHtj2kDecoder();
	const original = new Uint8Array(readFileSync(`${evidence}/firstframe.jph`));
	const reduced = await extractReduced({ byteLength: original.length,
		read: async (start, end) => original.slice(start, end),
	}, { width: 480, height: 270 }, { width: 3840, height: 2160, bits: 16 });
	const file = makeIndexedMxf({ htj2k: { data: reduced.data, bits: 16, width: 3840, height: 2160 },
		editRate: [24, 1], videoOnly: true });
	const bodyStart = file.offsets[0]! + file.regions[1]!.data.length;
	const fills = new Map<number, Promise<void>>();
	const pending = new Set<Promise<void>>();
	const requests: { frame: number; start: number; end: number; cold: boolean; at: number; done?: number }[] = [];
	let active = 0;
	let peak = 0;
	let activePayloads = 0;
	let peakPayloads = 0;
	const input = new Input({ formats: [MXF], source: new UrlSource('https://fixture.invalid/cold.mxf', {
		parallelism: 48, rangePolicy: { minimumRequestSize: 32768 },
		requestInit: { cache: 'no-store' },
		fetchFn: async (_url, init) => {
			const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
			const start = Number(match[1]);
			const end = Number(match[2]) + 1;
			if (start >= bodyStart && start < bodyStart + 1000 * file.stride) {
				const frame = Math.floor((start - bodyStart) / file.stride);
				const cold = !fills.has(frame);
				const request = { frame, start, end, cold, at: performance.now() };
				requests.push(request);
				if (cold) fills.set(frame, new Promise(resolve => setTimeout(resolve, 1300)));
				const payload = end - start > 57;
				peak = Math.max(peak, ++active);
				if (payload) peakPayloads = Math.max(peakPayloads, ++activePayloads);
				const wait = fills.get(frame)!.then(async () => {
					if (!cold) await new Promise(resolve => setTimeout(resolve, 20));
				});
				pending.add(wait);
				await wait;
				pending.delete(wait);
				active--;
				if (payload) activePayloads--;
				Object.assign(request, { done: performance.now() });
			}
			return new Response(file.read(start, end), { status: 206,
				headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` } });
		},
	}) });
	return { input, file, requests,
		get peakRequests() { return peak; },
		get peakPayloads() { return peakPayloads; },
		drain: () => Promise.all(pending) };
};
