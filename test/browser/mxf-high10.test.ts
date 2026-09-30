import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';

describe('given High 10 AVC in MXF over HTTP', () => {
	it('should deliver packets independently of native decoder support', async () => {
		using input = new Input({ source: new UrlSource('/mxf-avc-high10.mxf'), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		await track.canDecode();
		const packet = (await new EncodedPacketSink(track).getFirstPacket())!;
		expect([packet.type, packet.timestamp, packet.byteLength]).toEqual(['key', 0, 5254]);
		expect(packet.data.byteLength).toBe(5254);
	});
	it('should decode reordered pictures and seek back into a closed GOP', async (context) => {
		using input = new Input({ source: new UrlSource('/mxf-avc-high10.mxf'), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		if (!await track.canDecode()) {
			context.skip();
		}
		const sink = new VideoSampleSink(track);
		let count = 0;
		for await (using sample of sink.samples()) {
			expect([sample.timestamp, sample.displayWidth, sample.displayHeight]).toEqual([count++ / 25, 320, 192]);
		}
		expect(count).toBe(16);
		for (const time of [0.52, 0.04]) {
			using sample = await sink.getSample(time);
			expect(sample).not.toBeNull();
			expect(sample!.timestamp).toBe(time);
		}
	});
});
