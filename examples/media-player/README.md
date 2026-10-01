# Media player

The default player supports ordinary audio/video playback. Select an MXF file or use Load URL for HTJ2K.

`?smooth=1&minimumRequestSize=32768` enables continuity-first HTJ2K playback. It accepts finite, indexed,
all-intra 24/1 fps video with square pixels and 16:9 coded dimensions, without audio or live tracks.
The reduced decoder's RPCL profile restrictions also apply. Unsupported inputs report an error rather than
falling back to full-resolution decoding. Remote reduced decoding requires a finite HTTP range policy.
`maximumRequestSize` optionally caps each HTTP request; neither setting caps total transferred bytes.

Smooth playback starts at a native level covering 120×68, with a six-second startup grace before trying 60×34.
It starts after two seconds of decoded video, or a shorter EOF tail, and queues up to three seconds.
It presents every decoded frame in order. Starvation freezes the displayed clock; late rendering does not drop
frames to catch up. Sustained spare decode capacity can raise the target through 240×135 to 480×270.
Pause refines the same timestamp at the native level covering 480×270 after 200 ms. Source dimensions and
decomposition levels must permit those reduced sizes. This is not full-source-resolution refinement.

The status line shows state, actual decoded dimensions, decoded seconds buffered, owned sample bytes, and lateness.
The budgets are separate: 32 MiB for queued/pending decoded RGBA samples, the decoder's 128 MiB preparation
allowance, and 6.5 MiB of display-anchored prefix reservations. They are not global memory or network caps.
Metadata and prefix warming never prove that decoding has all required bytes.

For a fixed reduced-resolution preview with the ordinary player, use
`?decodeWidth=480&decodeHeight=270&minimumRequestSize=32768`. Both dimensions must be positive integers.
Fixed dimensions cannot be combined with `smooth=1`.

Controller, packet, metadata, refill, and ordinary player tests use committed fixtures and require no external
media setup. The controller tests repeat an authored 960×540 RGB8 RPCL frame in synthetic MXF wrappers.
This does not establish camera/vendor interoperability or a playback-performance guarantee.
