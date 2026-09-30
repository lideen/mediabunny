import { describe, expect, it, vi } from 'vitest';
import { VideoSample, type VideoSampleInit } from '../../src/index.js';

const init = { format: 'I420' as const, codedWidth: 4, codedHeight: 4, timestamp: 0 };
const packed = () => [{ offset: 0, stride: 4 }, { offset: 16, stride: 2 }, { offset: 20, stride: 2 }];

describe('given independently owned I420 and I422 pixel buffers', () => {
	it.each(['I420', 'I422'] as const)('should retain copying-constructor isolation for %s', async (format) => {
		const bytes = Uint8Array.from({ length: format === 'I420' ? 24 : 32 }, (_, i) => i + 1);
		const expected = bytes.slice();
		using sample = new VideoSample(bytes, { format, codedWidth: 4, codedHeight: 4, timestamp: 0 });
		bytes.fill(0);
		const output = new Uint8Array(sample.allocationSize());
		await sample.copyTo(output);
		expect(output).toEqual(expected);
		expect(bytes.byteLength).toBe(expected.length);
	});

	it.each(['I420', 'I422'] as const)('should detach %s input and preserve a surviving clone', async (format) => {
		const bytes = Uint8Array.from({ length: format === 'I420' ? 24 : 32 }, (_, i) => i + 1);
		const expected = bytes.slice();
		const heldView = new Uint8Array(bytes.buffer);
		const sample = VideoSample.fromTransferredBuffer(bytes.buffer, {
			format, codedWidth: 4, codedHeight: 4, timestamp: 2, duration: 0.04,
			scan: 'interlaced-top-first',
		});
		expect(bytes.byteLength).toBe(0);
		expect(heldView.byteLength).toBe(0);
		using clone = sample.clone();
		sample.close();
		sample.close();
		const output = new Uint8Array(clone.allocationSize());
		await clone.copyTo(output);
		expect(output).toEqual(expected);
		expect(clone.scan).toBe('interlaced-top-first');
		expect(clone.timestamp).toBe(2);
		expect(clone.duration).toBe(0.04);
	});

	it('should leave the caller buffer usable when metadata validation fails', () => {
		const data = new ArrayBuffer(24);
		expect(() => VideoSample.fromTransferredBuffer(data, {
			format: 'I420', codedWidth: 0, codedHeight: 4, timestamp: 0,
		})).toThrow('codedWidth');
		expect(data.byteLength).toBe(24);
	});

	const invalidStorage: { name: string; size: number; options: Partial<VideoSampleInit> }[] = [
		{ name: 'one-byte pixels', size: 1, options: {} },
		{ name: 'missing planes', size: 24, options: { layout: [] } },
		{ name: 'extra plane', size: 24, options: { layout: [...packed(), { offset: 0, stride: 4 }] } },
		{ name: 'short luma stride', size: 24,
			options: { layout: [{ offset: 0, stride: 3 }, ...packed().slice(1)] } },
		{ name: 'negative offset', size: 24,
			options: { layout: [{ offset: -1, stride: 4 }, ...packed().slice(1)] } },
		{ name: 'last row outside buffer', size: 24,
			options: { layout: [...packed().slice(0, 2), { offset: 21, stride: 2 }] } },
		{ name: 'unsafe extent sum', size: 24,
			options: { layout: [{ offset: Number.MAX_SAFE_INTEGER, stride: 4 }, ...packed().slice(1)] } },
		{ name: 'unsafe stride product', size: 24,
			options: { layout: [{ offset: 0, stride: Number.MAX_SAFE_INTEGER }, ...packed().slice(1)] } },
		{ name: 'unsafe dimensions', size: 24, options: { codedWidth: Number.MAX_SAFE_INTEGER + 1 } },
		{ name: 'rounded chroma extent', size: 16, options: { codedWidth: 3, codedHeight: 3 } },
		{ name: 'visible region outside geometry', size: 24,
			options: { visibleRect: { left: 1, top: 0, width: 4, height: 4 } } },
	];
	it.each(invalidStorage)('should reject $name before detaching source storage', ({ size, options }) => {
		const data = new ArrayBuffer(size);
		const held = new Uint8Array(data);
		expect(() => VideoSample.fromTransferredBuffer(data, { ...init, ...options })).toThrow();
		expect(data.byteLength).toBe(size);
		held[0] = 17;
		expect(new Uint8Array(data)[0]).toBe(17);
	});

	it('should preserve padded offset planes independently of later caller layout mutation', async () => {
		const data = new Uint8Array(45);
		data.set([1, 2, 3, 4], 2);
		data.set([5, 6, 7, 8], 8);
		data.set([9, 10, 11, 12], 14);
		data.set([13, 14, 15, 16], 20);
		data.set([17, 18], 28);
		data.set([19, 20], 32);
		data.set([21, 22], 38);
		data.set([23, 24], 43);
		const view = data.subarray(2, 24);
		const layout = [{ offset: 2, stride: 6 }, { offset: 28, stride: 4 }, { offset: 38, stride: 5 }];
		using sample = VideoSample.fromTransferredBuffer(view.buffer, {
			...init, layout,
		});
		expect(data.byteLength).toBe(0);
		expect(view.byteLength).toBe(0);
		layout[0]!.offset = 35;
		layout[1]!.stride = 0;
		layout.length = 0;
		const output = new Uint8Array(24);
		await sample.copyTo(output);
		expect([...output]).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
		]);
	});

	it('should allow individually bounded overlapping source planes', async () => {
		const data = Uint8Array.from([1, 2, 3, 4]);
		using sample = VideoSample.fromTransferredBuffer(data.buffer, {
			...init, codedWidth: 2, codedHeight: 2,
			layout: [{ offset: 0, stride: 2 }, { offset: 0, stride: 1 }, { offset: 1, stride: 1 }],
		});
		const output = new Uint8Array(6);
		await sample.copyTo(output);
		expect([...output]).toEqual([1, 2, 3, 4, 1, 2]);
	});

	it('should reject views instead of implicitly consuming their backing buffers', () => {
		const view = new Uint8Array(24);
		// @ts-expect-error The public factory deliberately accepts only a complete ArrayBuffer.
		expect(() => VideoSample.fromTransferredBuffer(view, init)).toThrow('ArrayBuffer');
		expect(view.byteLength).toBe(24);
	});

	it.skipIf(typeof SharedArrayBuffer === 'undefined')('should reject shared storage without changing it', () => {
		const shared = new SharedArrayBuffer(24);
		expect(() => VideoSample.fromTransferredBuffer(shared as unknown as ArrayBuffer, init))
			.toThrow('ArrayBuffer');
		expect(shared.byteLength).toBe(24);
	});

	it('should reject an already-detached buffer', () => {
		const data = new ArrayBuffer(24);
		structuredClone(data, { transfer: [data] });
		expect(() => VideoSample.fromTransferredBuffer(data, init)).toThrow();
	});

	it('should fail explicitly without consuming input when structuredClone is unavailable', () => {
		const data = new ArrayBuffer(24);
		vi.stubGlobal('structuredClone', undefined);
		try {
			expect(() => VideoSample.fromTransferredBuffer(data, init)).toThrow('requires structuredClone');
			expect(data.byteLength).toBe(24);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
