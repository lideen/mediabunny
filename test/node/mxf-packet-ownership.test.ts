import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input.js';
import { MXF } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource } from '../../src/source.js';
import { makeMxf } from './mxf-fixture.js';

describe('given packets that do not belong to an MXF video track', () => {
	describe('when requesting a successor', () => {
		it('should reject a packet from another track', async () => {
			using input = new Input({ source: new BufferSource(makeMxf().data), formats: [MXF] });
			const video = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
			const audio = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
			const packet = (await audio.getFirstPacket())!;
			await expect(video.getNextPacket(packet)).rejects.toThrow(/belong/);
			await expect(video.getNextKeyPacket(packet)).rejects.toThrow(/belong/);
		});

		it('should reject packets from another input and caller-created packets', async () => {
			using first = new Input({ source: new BufferSource(makeMxf().data), formats: [MXF] });
			using second = new Input({ source: new BufferSource(makeMxf().data), formats: [MXF] });
			const sink = new EncodedPacketSink((await first.getPrimaryVideoTrack())!);
			const other = new EncodedPacketSink((await second.getPrimaryVideoTrack())!);
			await expect(sink.getNextPacket((await other.getFirstPacket())!)).rejects.toThrow(/belong/);
			await expect(sink.getNextPacket(new EncodedPacket(new Uint8Array(40), 'key', 0, 1)))
				.rejects.toThrow(/belong/);
		});
	});
});
