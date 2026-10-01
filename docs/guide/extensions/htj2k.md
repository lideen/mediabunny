---
description: Optional complete-frame HTJ2K RGB decoding for experimental MXF input.
---

# @mediabunny/htj2k

This experimental workspace package adds complete-frame HTJ2K decoding through Mediabunny's custom decoder API. It bundles scalar OpenJPH WASM and initializes it on first decode. Core Mediabunny does not import the extension.

```ts
import { registerHtj2kDecoder } from '@mediabunny/htj2k';

registerHtj2kDecoder();
```

Build the workspace with `npm run build`. MXF input is included in `ALL_FORMATS`, or can be selected explicitly with `formats: [MXF]`. Applications must register the extension. The bundles contain their WASM bytes; no asset URL, worker, SIMD, or cross-origin isolation is required. Registration is idempotent. Before registration, HTJ2K track capability queries return false.

## Supported profile

The input must be finalized, seekable OP1a MXF with frame-wrapped HTJ2K and an RGBA descriptor. The supported profile is progressive, full-range BT.709 RGB with three unsigned 8-bit or 16-bit components, no subsampling, one full-frame tile and tile-part, one quality layer, and reversible 5/3 coding. Complete frames are decoded at full resolution. The adapter validates SIZ, CAP, COD, QCD, and the tile boundary before native decoding and rejects unsupported geometry or coding features. Maximum dimensions are 8192 on either axis and 16,777,216 pixels in total; compressed frames are limited to 128 MiB.

The library identifier `htj2k` is not a native WebCodecs codec string. Decoding requires this extension or another registered custom decoder. HTJ2K is excluded from output formats, and no encoder is provided.

Pixels must be square. The MXF descriptor aspect ratio must equal its stored width divided by height; anamorphic descriptors are rejected rather than decoded with incorrect display dimensions.

## Precision and color

Output uses owned RGBA8 memory. RGB16 components are clamped to 0–65535 and shifted right by eight bits. Alpha is opaque. Samples retain BT.709 primaries and transfer, RGB matrix, and full range. BT.709 is not sRGB; renderers must respect this metadata. No YCbCr matrix or additional inverse color transform should be applied.

This is an eight-bit display path, not a full-precision RGB16 export API. Tests compare public RGBA8 samples against the original authored RGB8 and RGB16 patterns. Source provenance, rebuild instructions, licenses, and the exact supported subset are documented in the package's README and `vendor/` directory.

Decoding runs synchronously after initialization and uses existing sink backpressure. Disposal cannot interrupt a native frame already in progress. Native frame allocations are released after each decode; the shared WASM heap keeps its high-water allocation for reuse.
