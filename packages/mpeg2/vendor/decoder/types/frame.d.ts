/** Owned JS planes, independent of subsequent decoding, reset, cancel and close. */
export declare class Frame {
    #private;
    readonly width: number;
    readonly height: number;
    readonly chromaFormat: 'yuv420p' | 'yuv422p';
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly chromaWidth: number;
    readonly chromaHeight: number;
    readonly yStride: number;
    readonly cbStride: number;
    readonly crStride: number;
    readonly progressive: boolean;
    readonly progressiveSequence: boolean;
    readonly topFieldFirst: boolean;
    readonly temporalReference: number;
    readonly frameRateNumerator: number;
    readonly frameRateDenominator: number;
    readonly pixelAspectNumerator: number;
    readonly pixelAspectDenominator: number;
    readonly colorPrimaries: number | undefined;
    readonly colorTransfer: number | undefined;
    readonly colorMatrix: number | undefined;
    private constructor();
    /** Transfers the owned plane. Repeated calls return an empty array. */
    takeY(): Uint8Array;
    takeCb(): Uint8Array;
    takeCr(): Uint8Array;
    /** Releases untaken planes. Idempotent; metadata and already-taken planes remain valid. */
    clear(): void;
}
