# Private MPEG-2 decoder

`@mediabunny/mpeg2` is an optional local WASM decoder. **It is not licensed for public distribution or npm publication.** The Rust dependency has no selected project license. The local media-player example explicitly registers it, so generated example assets also remain private.

```ts
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';

registerMpeg2Decoder();
```

Use `formats: [MXF]` when creating the input. Registration does not add MXF to `ALL_FORMATS`, enable encoding or muxing, or install a server/native fallback.

This integration supports a [narrow indexed MPEG-2 MXF subset](../supported-formats-and-codecs#input-formats): progressive Main Profile / High and High-1440 Level 4:2:0, plus 4:2:2 Profile / High Level with profile byte `82`. It produces owned I420 or I422 samples at visible sequence dimensions. The 4:2:2 path supports frame pictures with FrameLayout 1 field-based descriptor geometry and woven interlaced output. Native per-picture flags preserve top-first or bottom-first scan order. It neither deinterlaces nor doubles the frame rate; canvas and VideoFrame conversions do not retain scan metadata. Separate field pictures, repeated-field cadence, scalable coding, D-10 and LXF remain unsupported.

Restart anchors contain sequence and GOP headers. Progressive Main-profile open-flag GOPs still require the MXF reader's bounded proof of an unreordered I/P-only interval. The 4:2:2 path uses an explicit decode-start plan for open-GOP B pictures. Initial leading Bs may receive header-only preroll only when strictly before the selection minimum. This preserves persistent matrix updates without emitting pixels or claiming entropy validation. Requested leading Bs instead require an earlier dependency anchor. Missing coverage or dependencies outside the 256-entry inversion window fail explicitly; the window is not a promise to support every 255-picture lookback. Ordinary packet iteration omits nothing, and there is no decode-from-frame-zero fallback.

Stored macroblock padding is not exposed as extra decoded pixels. Plane data, packet timestamps and durations remain independent of native reset and disposal. Unspecified color primaries and transfer remain unspecified.

The WASM bytes are bundled locally and compiled on first use without fetching another resource. Each decoder limits complete packets and padded frames to 8 MiB, with bounded native references and no 64-frame lifetime cap. Flush finishes a requested selection and resets for the next independent key; it does not claim complete-stream integrity when a selection omits trailing B pictures.

See `packages/mpeg2/README.md` and `vendor/PROVENANCE.json` for lifecycle details, exact artifact identity, permission limits and validation scope. Node tests compare authored progressive and open-GOP 4:2:2 fixtures to independent FAANI frame hashes, including matrix-state, planning-cutoff and asynchronous initialization regressions. These tests do not establish general MPEG-2 conformance. Browser acceptance of this integration requires a fresh-built runtime gate; historical progressive browser results do not verify the current interlaced path.

Chromium 154 verification of the bundled decoder covered all 18 fixture frames, backward selections, held samples after disposal, and canvas conversion. Both minified and unminified bundles matched every independent YUV plane hash. On independently selected uniform-chroma regions, canvas RGB differed from the floating-point BT.709 limited-range reference by at most 0.501 levels per channel. The built media player displayed all 18 frames on playback and replay, reached natural EOF, and scheduled the stereo PCM buffers. This 0.72-second local fixture does not establish sustained real-time performance or broader format support. The entire generated example deployment must remain private because its shared bundle includes this decoder.
