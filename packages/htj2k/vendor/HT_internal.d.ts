export type NativeDecoder = {
	getCodestreamBuffer(): Uint8Array;
	readHeader(): void | Error;
	startDecoding(level: number, planar: boolean): void | Error;
	decodeLineAsUnsignedSamples(): Uint32Array | Error;
	delete(): void;
};
export type NativeModule = { HTDecoder: new (length: number) => NativeDecoder };
export default function makeHTCodec(options: {
	instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void): WebAssembly.Exports;
}): Promise<NativeModule>;
