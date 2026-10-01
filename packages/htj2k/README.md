# @mediabunny/htj2k

Optional complete-frame and explicitly reduced HTJ2K decoding for Mediabunny. The extension bundles a pinned scalar OpenJPH WebAssembly decoder. Core Mediabunny does not import it.

```ts
import { Input, MXF, UrlSource, VideoSampleSink } from 'mediabunny';
import { registerHtj2kDecoder } from '@mediabunny/htj2k';

registerHtj2kDecoder();
const input = new Input({
	formats: [MXF],
	source: new UrlSource(url, { requestInit: { mode: 'cors' } }),
});
const track = await input.getPrimaryVideoTrack();
if (track && await track.canDecode()) {
	const sample = await new VideoSampleSink(track).getSample(10);
	// Consume the sample, then close it and dispose the input.
	sample?.close();
}
input.dispose();
```

MXF is included in `ALL_FORMATS`, or can be selected explicitly with `formats: [MXF]`. Applications must register this extension themselves. Registration is idempotent and does not initialize WASM. Initialization is lazy, shared between decoder instances, and retried after failure. The bundles embed the WASM bytes, so there is no runtime asset URL, worker, SIMD requirement, or sibling-checkout dependency.

## Supported input

- Finalized, seekable OP1a MXF with frame-wrapped HTJ2K essence, RGBA descriptor, progressive RGB8 or RGB16, full component range, and BT.709 primaries and transfer. Pixels must be square: the descriptor aspect ratio must equal the stored width divided by height.
- Three unsigned full-resolution components, one full-image tile and one tile-part, one quality layer, reversible 5/3 transform, up to six decompositions, and HT-only code blocks up to 64×64. RPCL and the other standard progression orders are accepted. The decoder applies the codestream's inverse color transform once.
- At most 8192 pixels on either axis, 16,777,216 pixels per image, and 128 MiB per compressed frame. These bounds are checked before native frame allocation.

Unsupported inputs fail rather than being reinterpreted as ProRes, YCbCr, XYZ, or signed RGB. Tile-header overrides, mixed HT/legacy blocks, lossy coding, subsampling, cropping, and interlacing are outside this initial profile. Encoded packets retain the complete original codestream, key-frame status, edit-unit timestamp, and duration. Metadata-only packet reads retain the existing KLV header probes without fetching complete frames. Index lookup and source prefetch limits are unchanged.

The library codec name and decoder configuration string are `htj2k`. This is an internal custom-decoder identifier, **not a registered WebCodecs codec string**. MXF configurations carry a one-byte `description` containing the RGB component depth, 8 or 16. Geometry and component properties must match the codestream SIZ marker. Without a matching registered decoder, capability queries return false instead of probing a native `VideoDecoder` with this string. Initialization and decode failures propagate; there is no native fallback.

There is no HTJ2K encoder or muxer support. MP4, CMAF, MOV, and Matroska output codec lists exclude it. This extension does not implement a playback controller, automatic resolution adaptation, or a separate player.

## Explicit reduced decoding

```ts
const input = new Input({
	formats: [MXF],
	source: new UrlSource(url, { rangePolicy: { minimumRequestSize: 32768 } }),
});
const track = await input.getPrimaryVideoTrack();
if (track) {
	const sink = new VideoSampleSink(track, {
		reducedResolution: { width: 480, height: 270 },
	});
	const sample = await sink.getSample(10);
	sample?.close();
}
input.dispose();
```

Register the decoder before using the sink. For `CanvasSink`, put the same `reducedResolution` value in `decoderOptions`. Canvas sizing, fitting, rotation and flipping retain their existing behavior. Explicit Canvas cropping with reduced decoding rejects.

Both dimensions are minimum coded-raster dimensions, not a crop or exact resize. The decoder chooses the largest integer wavelet reduction whose entire declared raster still meets both dimensions. For example, 3840×2160 requested at 480×270 uses skip 3. A request that requires the complete resolution rejects instead of falling back. Omit `reducedResolution` to use the unchanged complete-frame path.

The reduced profile additionally requires RPCL progression, reversible MCT, one quality layer, explicit precincts, one guard bit, and one to six decompositions. Precinct dimensions are at most 1024×1024 and must contain the codeblocks. There are at most 65,536 packets and 262,144 retained codeblock positions. Unsupported layouts, malformed required headers, or missing physical read coverage reject.

Reads are finite, packet-relative ranges over the original codestream. HTTP sources must opt into `rangePolicy` and return valid 206 responses; this also applies through sliced and pathed sources. The extractor refills in 640 KiB windows, or the required body size if larger, capped at the original packet end. Small codestreams may therefore be read completely. Metadata navigation uses bounded KLV and index reads without fetching full frame bodies. There is no general guarantee that every source-cache or metadata read avoids neighboring essence.

The extractor builds a private derived codestream containing required resolution packets and empty omitted packets. It never replaces an original `EncodedPacket` or decoder configuration. Required coverage is validated exactly, including its last requested byte. Entropy belonging to omitted resolutions is not validated; successful reduced decoding does not certify the complete original codestream.

Range iteration permits two preparation slots, each with a 64 MiB working-buffer budget including buffer replacement overlap. Source caches, native memory and decoded samples are outside this budget. Preparation can overlap, but native decoding and disposal are serialized. Timestamp iteration uses serial reduced decoding. Returning an iterator aborts its reads, drops ready inputs, and disposes late preparations. An input already in native decoding stays alive until that call settles. Synchronous WASM decoding cannot be interrupted.

## Precision, color, and ownership

Mediabunny's packed RGB sample formats are eight-bit. The extension returns owned RGBA8 storage, clamps each reconstructed component to its unsigned range, then shifts RGB16 values right by eight bits. Alpha is 255. The output retains `{ primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true }`. BT.709 transfer is not sRGB; no sRGB conversion or mastering-display interpretation is asserted. A renderer must respect this metadata. Canvas screenshots alone do not prove color accuracy or full-precision decoding.

The decoder consumes each borrowed native component row before pulling the next one and deletes the native decoder in `finally`. Held samples never alias native memory. Decoding is synchronous after lazy initialization and uses the existing sink queue limits. Input disposal cannot interrupt an in-progress native frame; it prevents further sink work once that call returns. The shared WASM heap retains its allocation high-water mark for reuse.

## Verification and provenance

`test/node/htj2k.test.ts` exercises registration, capabilities, output exclusion, indexed seek, packet identity, RGB8/RGB16 decode, held-sample ownership, and malformed frames through public APIs. `test/browser/htj2k.test.ts` checks the bundled decoder and native `VideoFrame` color metadata. Run the Node tests with:

```sh
npm run pre-test
npx vitest run --project node test/node/htj2k.test.ts test/node/custom-video-decoder.test.ts
```

See `vendor/README.md` for pinned source, hashes, rebuild steps, and third-party licenses. No native build is needed to consume or build this package from the checked-in runtime.

### Fixture license

The `test/public/htj2k-rpcl-*` fixtures are original deterministic patterns dedicated to CC0-1.0. Their generation recipe and geometry are recorded inline in `test/node/htj2k-reduced.test.ts`. They cover empty high-pass subbands and packet-header bit stuffing. Valid HT placeholder passes with refinement segments are not represented by these encoder-generated fixtures; OpenJPH 0.32.0 emits one coding pass.

The `test/public/htj2k-rgb8*` and `htj2k-rgb16.j2c`/`htj2k-rgb16.mxf` fixtures contain original 8×4 patterns from OpenHTJS commit `a0e1dbbd68e9e4be6beec50abf15ea792fe19f51`, not demonstration-media imagery. `htj2k-rgb16-edges.mxf` contains an original authored pattern with values around eight-bit quantization boundaries and a second phase with reversed pixel order. The owning Node test records source values and encoding/wrapping recipes. All these patterns and codestreams use this license:

```text
MIT License

Copyright, the respective contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
