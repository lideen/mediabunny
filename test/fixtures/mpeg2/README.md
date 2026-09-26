# MPEG-2 MXF fixture

`main420.mxf` contains authored moving luma/chroma ramps and stereo sine waves. No external media was used. It is unmodified FFmpeg 7.1.1 OP1a output, with 18 progressive 1280×720 Main Profile / High Level 4:2:0 pictures at 25 fps and 48 kHz stereo PCM16. Both tracks last 0.72 seconds. The actual closed GOP keys are decode ordinals 0 and 10, despite the encoder's requested GOP size of 12.

- File size: 232,505 bytes.
- SHA-256: `be9c27eb454997c802ac06a6c8434d70826ab038cf642b53fd7f640f117eda8b`.
- `packets.json` is independent ffprobe output with timestamps, complete essence sizes, and SHA-256 hashes for all 36 packets.
- Regenerate with `python3 test/node/generate-mxf-mpeg2.py <new-directory>`. The generator does not apply the AVC fixture's index correction. Tool-version changes and generated MXF identifiers can change the file hash; compare packet hashes separately.

The sequence-display extension specifies BT.709 matrix coefficients but leaves primaries and transfer unspecified. The encoder command's requested primaries/transfer are not the bitstream metadata.

`pixels.json` contains independent per-frame Y/Cb/Cr SHA-256 hashes in display order. Generate the raw reference with installed FFmpeg 7.1.1, then hash it without using the decoder under test:

```sh
ffmpeg -v error -y -c:v mpeg2video -idct faani -i test/fixtures/mpeg2/main420.mxf \
  -map 0:v:0 -fps_mode passthrough -pix_fmt yuv420p -f rawvideo /path/to/expected-faani.yuv
python3 test/node/generate-mpeg2-pixel-hashes.py /path/to/expected-faani.yuv
```

The raw reference is 24,883,200 bytes with SHA-256 `0b1f18b0b54bcd670c1dd34fe125fc4e0504017d44ca913dd487019c4f23f620`. It is intentionally not committed. The independent retained native ES output matched it exactly for this fixture. This is not a general promise of bit-exact MPEG-2 IDCT results for other media.

The demux tests verify packet extraction and restart headers. The optional private `@mediabunny/mpeg2` tests additionally prove decoded planes, timing and lifecycle through the real bundled WASM. Node tests do not establish browser canvas color conversion or playback.
