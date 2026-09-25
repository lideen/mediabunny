import { describe, expect, it } from 'vitest';
import { CustomSource, CustomPathedSource, EncodedPacketSink, Input, MXF } from '../../src/index.js';
import { makeIndexedMxf } from './mxf-indexed-fixture.js';

describe('given public packet retrieval cancellation', () => {
	it('should stop a packet iterator rather than yield queued packets after abort', async () => {
		const file = makeIndexedMxf();
		using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
			read: file.read }) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const controller = new AbortController();
		const iterator = sink.packets(undefined, undefined, { metadataOnly: true, signal: controller.signal });
		try {
			expect((await iterator.next()).value?.timestamp).toBe(0);
			const reason = new Error('Consumer stopped');
			controller.abort(reason);
			await expect(iterator.next()).rejects.toBe(reason);
		} finally { await iterator.return(); }
	});

	it('should reject invalid and already-aborted signals before reading a packet', async () => {
		const file = makeIndexedMxf();
		using input = new Input({ formats: [MXF], source: new CustomSource({ getSize: () => file.size,
			read: file.read }) });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const controller = new AbortController();
		const reason = new Error('No longer needed');
		controller.abort(reason);
		const before = file.reads.length;
		// @ts-expect-error Deliberately invalid user option.
		await expect(sink.getPacket(0, { metadataOnly: true, signal: {} })).rejects.toThrow(TypeError);
		await expect(sink.getPacket(0, { metadataOnly: true, signal: controller.signal })).rejects.toBe(reason);
		expect(file.reads.length).toBe(before);
	});

	describe.each(['direct', 'slice', 'pathed'] as const)('when canceling through a %s source', (wrapper) => {
		it('should reject promptly while preserving shared readers and cached metadata', async () => {
			const file = makeIndexedMxf();
			let hold = false;
			let release!: () => void;
			let admitted!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				admitted = resolve;
			});
			const source = new CustomSource({ getSize: () => file.size, maxCacheSize: 0,
				read: async (start, end) => {
					if (hold) {
						admitted();
						await gate;
					}
					return file.read(start, end);
				} });
			const wrapped = wrapper === 'slice'
				? source.slice(0, file.size)
				: wrapper === 'pathed' ? new CustomPathedSource('/root.mxf', async () => source) : source;
			using input = new Input({ formats: [MXF], source: wrapped });
			const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			await sink.getPacket(0, { metadataOnly: true });
			hold = true;
			const controller = new AbortController();
			const canceled = sink.getPacket(40, { metadataOnly: true, signal: controller.signal })
				.then(value => ({ value }), error => ({ error: error as unknown }));
			try {
				await started;
				const shared = sink.getPacket(40, { metadataOnly: true });
				void shared.catch(() => {});
				const reason = new Error('Seek retired');
				controller.abort(reason);
				const result = await Promise.race([canceled,
					new Promise(resolve => setTimeout(() => resolve('not canceled promptly'), 100))]);
				expect(result).toEqual({ error: reason });
				release();
				const packet = (await shared)!;
				expect([packet.timestamp, packet.sequenceNumber, packet.isMetadataOnly]).toEqual([40, 1000, true]);
				const reads = file.reads.length;
				const again = (await sink.getPacket(40, { metadataOnly: true }))!;
				expect([again.timestamp, again.sequenceNumber]).toEqual([40, 1000]);
				expect(file.reads.length).toBe(reads);
			} finally { release(); }
		});
	});
});
