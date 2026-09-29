import { describe, expect, it } from 'vitest';
import { AudioBufferSink, BlobSource, EncodedPacketSink, Input, MXF, VideoSampleSink } from 'mediabunny';
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';
import { qualificationScope, readQualificationManifest } from '../mpeg2-qualification-manifest.js';

const directory = import.meta.env['VITE_MPEG2_QUALIFICATION_MEDIA'] as string | undefined;
const paced = import.meta.env['VITE_MPEG2_QUALIFICATION_PACED'] === '1';
const hash = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(
	new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0'),
).join('');
const resource = (file: string) => `/@fs/${directory}/${file}`;

describe.skipIf(!directory)('given a packaged MPEG-2 decoder and generated HD moving patterns', () => {
	it('should decode one continuous chain, retain owned planes, render woven fields and seek after EOF', async () => {
		registerMpeg2Decoder();
		const browserVersions = await (navigator as Navigator & {
			userAgentData?: { getHighEntropyValues: (hints: string[]) => Promise<unknown> };
		}).userAgentData?.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture']);
		const manifest = readQualificationManifest(await (await fetch(resource('manifest.json'))).json(), paced);
		const results = [];
		for (const fixture of manifest.cases) {
			const blob = await (await fetch(resource(fixture.file))).blob();
			expect(await hash(new Uint8Array(await blob.arrayBuffer()))).toBe(fixture.sha256);
			using input = new Input({ source: new BlobSource(blob), formats: [MXF] });
			const track = (await input.getPrimaryVideoTrack())!;
			let packetCount = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				const expected = fixture.packets[packetCount++]!;
				expect(packet.timestamp).toBeCloseTo(expected.timestamp, 6);
				expect(packet.duration).toBeCloseTo(expected.duration, 6);
				expect(await hash(new Uint8Array(packet.data))).toBe(expected.sha256);
			}
			expect(packetCount).toBe(fixture.frames);
			const sink = new VideoSampleSink(track);
			const canvas = document.createElement('canvas');
			canvas.width = fixture.width;
			canvas.height = fixture.height;
			const context = canvas.getContext('2d', { willReadFrequently: true })!;
			const selected = new Map<number, string>();
			const renderErrors = [];
			let ordinal = 0;
			let lastTimestamp = -1;
			let held: Uint8Array<ArrayBuffer> | undefined;
			let heldHash = '';
			let lateFrames = 0;
			let maxLatenessMs = 0;
			const start = performance.now();
			for await (const sample of sink.samples()) {
				try {
					expect([sample.format, sample.scan, sample.codedWidth, sample.codedHeight])
						.toEqual([fixture.format, fixture.scan, fixture.width, fixture.height]);
					expect(sample.timestamp).toBeCloseTo(ordinal / 25, 6);
					expect(sample.duration).toBeCloseTo(1 / 25, 6);
					if (paced) {
						const delay = start + sample.timestamp * 1000 - performance.now();
						if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
						const lateness = performance.now() - start - sample.timestamp * 1000;
						if (lateness > 40) lateFrames++;
						maxLatenessMs = Math.max(maxLatenessMs, lateness);
					}
					sample.draw(context, 0, 0);
					if (fixture.references[ordinal]) {
						const pixels = new Uint8Array(sample.allocationSize());
						await sample.copyTo(pixels);
						selected.set(ordinal, await hash(pixels));
						if (ordinal === 0) {
							held = pixels;
							heldHash = selected.get(ordinal)!;
						}
						const reference = new Uint8Array(await (await fetch(resource(fixture.references[ordinal]!)))
							.arrayBuffer());
						const rendered = context.getImageData(0, 0, canvas.width, canvas.height).data;
						expect(rendered.length).toBe(reference.length);
						let error = 0;
						for (let i = 0; i < rendered.length; i += 4) {
							for (let c = 0; c < 3; c++) error += Math.abs(rendered[i + c]! - reference[i + c]!);
						}
						const meanAbsoluteError = error / (fixture.width * fixture.height * 3);
						expect(meanAbsoluteError).toBeLessThan(6);
						renderErrors.push({ ordinal, meanAbsoluteError });
					}
					lastTimestamp = sample.timestamp;
					ordinal++;
				} finally { sample.close(); }
			}
			expect(ordinal).toBe(fixture.frames);
			expect(lastTimestamp).toBeCloseTo((fixture.frames - 1) / 25, 6);
			const continuousMs = performance.now() - start;
			for (const target of [...selected.keys()].reverse()) {
				using sample = (await sink.getSample(target / 25))!;
				expect(sample.timestamp).toBeCloseTo(target / 25, 6);
				const bytes = new Uint8Array(sample.allocationSize());
				await sample.copyTo(bytes);
				expect(await hash(bytes)).toBe(selected.get(target));
			}
			const audioTrack = (await input.getPrimaryAudioTrack())!;
			let audioFrames = 0;
			for await (const { buffer, timestamp } of new AudioBufferSink(audioTrack).buffers()) {
				expect(timestamp).toBeCloseTo(audioFrames / 48000, 6);
				audioFrames += buffer.length;
			}
			expect(audioFrames).toBe(fixture.duration * 48000);
			const controller = new AbortController();
			const pending = sink.getSample(fixture.duration / 2, { signal: controller.signal });
			const observed = pending.then((sample) => {
				sample?.close();
				return 'completed';
			}, error => error as unknown);
			const abortStart = performance.now();
			controller.abort();
			expect(await observed).toBe(controller.signal.reason);
			const abortSettlementMs = performance.now() - abortStart;
			input.dispose();
			expect(await hash(held!)).toBe(heldHash);
			results.push({ name: fixture.name, frames: ordinal, packetCount, lastTimestamp, audioFrames,
				continuousMs, renderErrors, abortSettlementMs, ownedPlaneSurvivedDisposal: true,
				lateFrames: paced ? lateFrames : null, maxLatenessMs: paced ? maxLatenessMs : null });
		}
		console.log('MPEG2_QUALIFICATION', JSON.stringify({ userAgent: navigator.userAgent, browserVersions,
			crossOriginIsolated, paced, scope: qualificationScope(paced), results,
			limits: 'Sample draw calls, not compositor presentation. No player dropped-frame or A/V-sync claim. '
				+ 'Abort is immediate selection cancellation, not interruption inside native decode. '
				+ 'One held plane copy plus current sample; browser/worker heap reclamation is not measured.' }));
	}, 300_000);
});
