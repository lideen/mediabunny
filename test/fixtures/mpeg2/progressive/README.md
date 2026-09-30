# Authored progressive MPEG-2 variants

Generated from mathematical image/audio sources with FFmpeg/ffprobe 7.1.1 using
`python3 test/node/generate-mxf-mpeg2-progressive.py <new-directory>`.
No original movie packets, patched MXF indexes, or third-party media are included.

Both files contain 36 progressive 24 fps I/P pictures, stereo 48 kHz PCM16,
open-flag GOPs after the first key, consecutive I pictures and a final short GOP.
`padded-high.mxf` uses Main/High with visible width 1718 and stored width 1728;
`high1440.mxf` uses Main/High-1440 at 1280×720. Headers remain in-band.

The JSON manifests retain complete ffprobe packet hashes and timing, file hashes,
generation commands and independently decoded FAANI frame hashes. Raw planes are
not committed. The original `../main420.mxf` closed-I/P/B fixture is unchanged.

Tests assert packet hashes, timestamps, visible dimensions, bounded restart validation, and real decoded pixels at selected timestamps through public sample sinks. Pixel expectations come from `../wasm-bridct-v1.json`, preserving the decoder's numerical-version regressions rather than asserting exact agreement with FAANI. The retained FAANI frame hashes remain an independent provenance reference.
