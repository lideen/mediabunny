# @mediabunny/htj2k

Optional complete-frame HTJ2K decoding for Mediabunny. The extension bundles a pinned scalar OpenJPH WebAssembly decoder. Core Mediabunny does not import it.

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

MXF is opt-in. The existing `examples/media-player` registers the extension alongside ProRes. Registration is idempotent and does not initialize WASM. Initialization is lazy, shared between decoder instances, and retried after failure. The bundles embed the WASM bytes, so there is no runtime asset URL, worker, SIMD requirement, or sibling-checkout dependency.

## Supported input

- Finalized, seekable OP1a MXF with frame-wrapped HTJ2K essence, RGBA descriptor, progressive RGB8 or RGB16, full component range, and BT.709 primaries and transfer.
- Three unsigned full-resolution components, one full-image tile and one tile-part, one quality layer, reversible 5/3 transform, up to six decompositions, and HT-only code blocks up to 64×64. RPCL and the other standard progression orders are accepted. The decoder applies the codestream's inverse color transform once.
- At most 8192 pixels on either axis, 16,777,216 pixels per image, and 128 MiB per compressed frame. These bounds are checked before native frame allocation.

Unsupported inputs fail rather than being reinterpreted as ProRes, YCbCr, XYZ, or signed RGB. Tile-header overrides, mixed HT/legacy blocks, lossy coding, subsampling, cropping, and interlacing are outside this initial profile. Encoded packets retain the complete original codestream, key-frame status, edit-unit timestamp, and duration. Metadata-only packet reads do not fetch the payload. Index lookup and source prefetch limits are unchanged.

The library codec name and decoder configuration string are `htj2k`. This is an internal custom-decoder identifier, **not a registered WebCodecs codec string**. MXF configurations carry a one-byte `description` containing the RGB component depth, 8 or 16. Geometry and component properties must match the codestream SIZ marker. Without a matching registered decoder, capability queries return false instead of probing a native `VideoDecoder` with this string. Initialization and decode failures propagate; there is no native fallback.

There is no HTJ2K encoder or muxer support. MP4, CMAF, MOV, and Matroska output codec lists exclude it. This extension does not implement partial-codestream decoding, resolution-adaptive playback, or a separate player.

## Precision, color, and ownership

Mediabunny's packed RGB sample formats are eight-bit. The extension returns owned RGBA8 storage, clamps each reconstructed component to its unsigned range, then shifts RGB16 values right by eight bits. Alpha is 255. The output retains `{ primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true }`. BT.709 transfer is not sRGB; no sRGB conversion or mastering-display interpretation is asserted. A renderer must respect this metadata. Canvas screenshots alone do not prove color accuracy or full-precision decoding.

The decoder consumes each borrowed native component row before pulling the next one and deletes the native decoder in `finally`. Held samples never alias native memory. Decoding is synchronous after lazy initialization and uses the existing sink queue limits. Input disposal cannot interrupt an in-progress native frame; it prevents further sink work once that call returns. The shared WASM heap retains its allocation high-water mark for reuse.

## Verification and provenance

`test/node/htj2k.test.ts` exercises registration, capabilities, output exclusion, indexed seek, packet identity, RGB8/RGB16 decode, held-sample ownership, and malformed frames through public APIs. Tiny synthetic codestreams are MIT-licensed original patterns, not excerpts from the remote demonstration media.

For the separately retained real frame and FFmpeg oracle:

```sh
npm run pre-test
HTJ2K_EVIDENCE=/path/to/htj2k-evidence npx vitest run --project node test/node/htj2k.test.ts
```

That opt-in test reads only retained byte ranges from the original 17.7 GB MXF, checks packet identity and timing, compares full-resolution RGB16 against FFmpeg's independently decoded SHA-256 oracle, then compares the public sample's RGBA8 bytes to an independently quantized reference. It does not download the movie or redistribute that media.

See `vendor/README.md` for pinned source, hashes, rebuild steps, and third-party licenses. No native build is needed to consume or build this package from the checked-in runtime.
