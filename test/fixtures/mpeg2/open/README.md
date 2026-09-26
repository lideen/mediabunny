# Authored MPEG-2 4:2:2 fixtures

No source-movie bytes are included. These fixtures are part of the private MPEG-2 integration, not a distribution permission for the unlicensed native project.

`test/node/generate-mxf-mpeg2-open.py` takes the supplied read-only `mpeg2-rs` checkout and a new output directory. The source checkout used here was `1a9e585a52dcce079ca2543abe59aef50551f59a`. Its mathematical bit writers generate three 12-picture GOPs at 64×48. The first closed GOP begins with an I picture at temporal reference 2 followed by backward-predicted leading Bs at 0 and 1. Later GOPs are open. Only the first leading B of the second GOP updates the non-intra matrix. Omitting that header changes later selected pixels.

FFmpeg remuxes the authored elementary stream into `open422.mxf` without re-encoding. `open422.json` contains independent FFprobe packet hashes/timing and FFmpeg FAANI decoded frame hashes in presentation order. The script also creates `interlaced422.mxf` from an FFmpeg-generated gray source to exercise field-based descriptor geometry and top-first woven frame output. Its independent packet/frame manifest is `interlaced422.json`.

The non-flat open-GOP fixture owns dependency and matrix-pixel correctness. The gray interlaced fixture owns scan/geometry/clone behavior; it does not claim motion-adaptive deinterlacing or difficult interlaced prediction coverage. Original SWAT checks are retained outside the repository.
