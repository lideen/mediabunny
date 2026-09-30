import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';

describe.each([
	['100-720p50', 50, 1280, 720, 1280],
	['100-1080p25', 25, 1920, 1080, 1920],
	['50-720p50', 50, 1280, 720, 960],
	['50-1080p25', 25, 1920, 1080, 1440],
] as const)('given AVC-Intra %s MXF', (name, rate, width, height, codedWidth) => {
	it('should decode every picture and cold-seek to the final picture', async (context) => {
		const url = `/mxf-avci${name}.mxf`;
		using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		expect([await track.getCodedWidth(), await track.getCodedHeight(),
			await track.getDisplayWidth(), await track.getDisplayHeight()])
			.toEqual([codedWidth, height, width, height]);
		if (!await track.canDecode()) {
			context.skip();
		}
		let count = 0;
		for await (using sample of new VideoSampleSink(track).samples()) {
			expect([sample.timestamp, sample.displayWidth, sample.displayHeight])
				.toEqual([count++ / rate, width, height]);
		}
		expect(count).toBe(4);
		input.dispose();

		using coldInput = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
		const coldTrack = (await coldInput.getPrimaryVideoTrack())!;
		using sample = await new VideoSampleSink(coldTrack).getSample(3 / rate);
		expect(sample).not.toBeNull();
		expect([sample!.timestamp, sample!.displayWidth, sample!.displayHeight])
			.toEqual([3 / rate, width, height]);
	});
});
