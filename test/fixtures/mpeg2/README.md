# MPEG-2 MXF fixture

`main420.mxf` contains authored moving luma/chroma ramps and stereo sine waves. No external media was used. It is unmodified FFmpeg 7.1.1 OP1a output, with 18 progressive 1280×720 Main Profile / High Level 4:2:0 pictures at 25 fps and 48 kHz stereo PCM16. Both tracks last 0.72 seconds. The actual closed GOP keys are decode ordinals 0 and 10, despite the encoder's requested GOP size of 12.

- File size: 232,505 bytes.
- SHA-256: `be9c27eb454997c802ac06a6c8434d70826ab038cf642b53fd7f640f117eda8b`.
- `packets.json` is independent ffprobe output with timestamps, complete essence sizes, and SHA-256 hashes for all 36 packets.
- Regenerate with `python3 test/node/generate-mxf-mpeg2.py <new-directory>`. The generator does not apply the AVC fixture's index correction. Tool-version changes and generated MXF identifiers can change the file hash; compare packet hashes separately.

The sequence-display extension specifies BT.709 matrix coefficients but leaves primaries and transfer unspecified. The encoder command's requested primaries/transfer are not the bitstream metadata.

The tests verify packet extraction, timing, restart headers, and real decoding through the optional private MPEG-2 extension. `wasm-bridct-v1.json` records regression hashes generated through the built adapter with the pinned `bridct-f32-simd128-dc-v1` decoder on existing demuxed packets. It identifies the packaging commit, dirty WASM source snapshot, module, and embedded binaries used to generate the expectations. Historical decoder hashes and delta histograms are not retained.

During this import, all 144 frames across the five original fixtures matched independently regenerated FFmpeg 7.1.1 FAANI bytes exactly, including visible width 1718 for the padded fixture. Packet bytes and timing also remained unchanged. The additional synthetic cutoff selection comes from `boundaryFixture()` in `test/node/mxf-mpeg2-cutoff.test.ts`; its recorded input/packet hashes and selected frame are regression-only, not an independent reference. These finite comparisons do not establish general numerical conformance.

`pixels.json` contains independent FFmpeg FAANI planes and timing. Generate the raw reference with FFmpeg 7.1.1:

```sh
ffmpeg -idct faani -i test/fixtures/mpeg2/main420.mxf -map 0:v:0 -pix_fmt yuv420p -f rawvideo expected-faani.yuv
python3 test/node/generate-mpeg2-pixel-hashes.py expected-faani.yuv
```

Current decoder tests use `pixels.json` timing and the numerical-version plane hashes, not exact FAANI pixel equality. Neither those hashes nor packet comparisons establish general decoded-picture accuracy, browser playback performance, or canvas color conversion.

`test/mpeg2-fixture.ts` derives an anamorphic variant in memory by changing the MXF descriptor and every sequence header from 16:9 to 4:3 display aspect. Coded dimensions and slice data stay unchanged. Real decoded samples must retain PAR 3:4 and 1280×960 display geometry, while preserving the same coded pixel hashes. The browser regression also checks `toVideoFrame()` geometry.
