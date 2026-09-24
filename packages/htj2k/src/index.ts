/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomVideoDecoder, EncodedPacket, registerDecoder, VideoCodec, VideoSample } from 'mediabunny';
import makeHTCodec, { NativeModule } from '../vendor/HT_internal.js';
import wasmBinary from '../vendor/HT_internal.wasm';
import { requireHt, validDimensions, validateCodestream } from './codestream.js';

let modulePromise: Promise<NativeModule> | null = null;
const loadModule = () => modulePromise ??= WebAssembly.compile(wasmBinary).then(module => makeHTCodec({
	instantiateWasm(imports, receive) {
		const instance = new WebAssembly.Instance(module, imports);
		receive(instance);
		return instance.exports;
	},
})).catch((error: unknown) => {
	modulePromise = null;
	throw error;
});

const checked = <T>(result: T | Error): T => {
	if (result instanceof Error) {
		throw result;
	}
	return result;
};

const bitDepth = (config: VideoDecoderConfig) => {
	const description = config.description;
	if (!description) {
		return null;
	}
	const bytes = ArrayBuffer.isView(description)
		? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
		: new Uint8Array(description);
	return bytes.length === 1 && (bytes[0] === 8 || bytes[0] === 16) ? bytes[0] : null;
};

class Htj2kDecoder extends CustomVideoDecoder {
	private module: NativeModule | null = null;
	private closed = false;

	static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
		return codec === 'htj2k' && config.codec === 'htj2k' && bitDepth(config) !== null
			&& validDimensions(config.codedWidth, config.codedHeight)
			&& config.colorSpace?.primaries === 'bt709' && config.colorSpace.transfer === 'bt709'
			&& config.colorSpace.matrix === 'rgb' && config.colorSpace.fullRange === true;
	}

	async init() {
		const module = await loadModule();
		if (!this.closed) {
			this.module = module;
		}
	}

	decode(packet: EncodedPacket) {
		requireHt(!this.closed && this.module, 'decoder is closed or uninitialized');
		const width = this.config.codedWidth!;
		const height = this.config.codedHeight!;
		const bits = bitDepth(this.config)!;
		validateCodestream(packet.data, width, height, bits);
		const rgba = new Uint8Array(width * height * 4);
		const decoder = new this.module.HTDecoder(packet.data.length);
		try {
			decoder.getCodestreamBuffer().set(packet.data);
			checked(decoder.readHeader());
			checked(decoder.startDecoding(0, false));
			const max = 2 ** bits - 1;
			const shift = bits - 8;
			for (let y = 0; y < height; y++) {
				for (let c = 0; c < 3; c++) {
					const row = checked(decoder.decodeLineAsUnsignedSamples());
					requireHt(row.length === width, 'decoded row width');
					// The next native pull invalidates this borrowed row.
					for (let x = 0; x < width; x++) {
						rgba[(y * width + x) * 4 + c] = Math.min(max, Math.max(0, row[x]! | 0)) >>> shift;
					}
				}
				for (let x = 0; x < width; x++) {
					rgba[(y * width + x) * 4 + 3] = 255;
				}
			}
		} finally {
			decoder.delete();
		}
		this.onSample(new VideoSample(rgba, {
			format: 'RGBA', codedWidth: width, codedHeight: height,
			timestamp: packet.timestamp, duration: packet.duration, colorSpace: this.config.colorSpace,
		}));
	}

	flush() {}

	close() {
		this.closed = true;
		this.module = null;
	}
}

let registered = false;

/**
 * Registers a complete-frame HTJ2K decoder for progressive, full-range BT.709 RGB8/RGB16 MXF tracks.
 * Decoded samples use RGBA8, retaining BT.709 color metadata. RGB16 values are clamped and shifted right by eight bits.
 * This does not register an encoder or enable HTJ2K muxing.
 * @group \@mediabunny/htj2k
 * @public
 */
export const registerHtj2kDecoder = () => {
	if (!registered) {
		registerDecoder(Htj2kDecoder);
		registered = true;
	}
};
