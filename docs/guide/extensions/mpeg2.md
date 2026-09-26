# Private MPEG-2 decoder

`@mediabunny/mpeg2` is an optional local WASM decoder. **It is not licensed for public distribution or npm publication.** The Rust dependency has no selected project license. The local media-player example explicitly registers it, so generated example assets also remain private.

```ts
import { registerMpeg2Decoder } from '@mediabunny/mpeg2';

registerMpeg2Decoder();
```

Use `formats: [MXF]` when creating the input. Registration does not add MXF to `ALL_FORMATS`, enable encoding or muxing, or install a server/native fallback.

This integration supports the [narrow progressive Main Profile / High and High-1440 Level 4:2:0 MXF subset](../supported-formats-and-codecs#input-formats) and produces owned I420 samples at visible sequence dimensions. Restart keys contain their sequence and GOP headers. Open-flag GOPs require the MXF reader's bounded index-and-picture-header proof of an unreordered I/P-only interval; open GOPs with B pictures remain unsupported. Stored macroblock padding is not exposed as extra decoded pixels. D-10, LXF, 4:2:2 and interlaced MXF are unsupported. Plane data, packet timestamps and durations remain independent of native reset and disposal. Unspecified color primaries and transfer remain unspecified.

The WASM bytes are bundled locally and compiled on first use without fetching another resource. Each decoder limits complete packets and padded frames to 8 MiB, with bounded native references and no 64-frame lifetime cap. Flush finishes a requested selection and resets for the next independent key; it does not claim complete-stream integrity when a selection omits trailing B pictures.

See `packages/mpeg2/README.md` and `vendor/PROVENANCE.json` for lifecycle details, exact artifact identity, permission limits and validation scope. Node tests compare the authored two-GOP 720p fixture to independent FAANI plane hashes. Real-browser canvas verification is separate.

Chromium 154 verification of the bundled decoder covered all 18 fixture frames, backward selections, held samples after disposal, and canvas conversion. Both minified and unminified bundles matched every independent YUV plane hash. On independently selected uniform-chroma regions, canvas RGB differed from the floating-point BT.709 limited-range reference by at most 0.501 levels per channel. The built media player displayed all 18 frames on playback and replay, reached natural EOF, and scheduled the stereo PCM buffers. This 0.72-second local fixture does not establish sustained real-time performance or broader format support. The entire generated example deployment must remain private because its shared bundle includes this decoder.
