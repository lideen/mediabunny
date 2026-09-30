import packets from './fixtures/mpeg2/packets.json' with { type: 'json' };

/** Changes only display aspect, coherently in the MXF descriptor and every MPEG-2 sequence header. */
export const anamorphicMpeg2Fixture = (original: Uint8Array) => {
	const data = new Uint8Array(original);
	const aspect = Uint8Array.of(0x32, 0x0e, 0, 8, 0, 0, 0, 16, 0, 0, 0, 9);
	let descriptors = 0;
	for (let offset = 0; offset <= data.length - aspect.length; offset++) {
		if (aspect.every((byte, index) => data[offset + index] === byte)) {
			data[offset + 7] = 4;
			data[offset + 11] = 3;
			descriptors++;
		}
	}
	if (descriptors !== 1) {
		throw new Error('Expected one 16:9 MXF picture descriptor');
	}
	const keys = packets.packets.filter(packet => packet.codec_type === 'video' && packet.flags.includes('K'));
	for (const packet of keys) {
		const start = Number(packet.pos) + 20;
		if (!Uint8Array.of(0, 0, 1, 0xb3).every((byte, index) => data[start + index] === byte)) {
			throw new Error('Expected MPEG-2 sequence header at key packet');
		}
		data[start + 7] = (data[start + 7]! & 15) | 0x20; // H.262 aspect_ratio_information=2 means 4:3 DAR.
	}
	return data;
};
