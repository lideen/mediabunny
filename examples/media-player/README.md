# Media-player example

Build with `npm run build`, start `npm run dev`, and open `/examples/media-player/`. The player accepts local files and remote URLs, including experimental MXF input. Optional decoders are registered in `media-player.ts`.

## Finite HTTP ranges

Open `/examples/media-player/?minimumRequestSize=32768` to opt remote URL loads into `UrlSource`'s finite-range policy with a 32 KiB request floor. The parameter belongs to the example page URL, not the media URL. `UrlSource` validates the numeric value; invalid values appear as a load error. Local file loads are unaffected. Omitting the parameter preserves the default adaptive transport, which may issue open-ended requests.

This setting is useful for servers that require finite byte ranges and for measuring remote-media access. It is not a per-request maximum or a total transfer budget: large packets can require larger requests and the source can read ahead. Use an independent server-side budget when inspecting large remote files. The player does not synthesize missing bytes or disable normal sink backpressure.

## Paused previews and playback

For explicit HTJ2K reduced decoding, add both `decodeWidth` and `decodeHeight`, for example `/examples/media-player/?minimumRequestSize=32768&decodeWidth=480&decodeHeight=270`. Remote reduced loads require a finite request floor before any metadata is read. Unsupported codecs, layouts, and requests that require full resolution report an error instead of falling back. The URL must remain immutable; this example does not verify ETags. The server must honor finite Range requests and expose Content-Range through CORS. This option is independent of canvas display dimensions and is off by default.

Loading and seeking while paused use `CanvasSink.getCanvas(timestamp)`, without starting a sequential video iterator or an audio iterator. Inter-frame codecs still require their normal decoding dependencies. Play starts the existing buffered video/audio iterators; pause and seek return them and invalidate pending work before requesting a new preview. An in-flight read or native decode can finish, but an obsolete generation cannot draw, schedule audio, or restart playback. Playback and seek errors appear in the player's error element.

Each paused request owns a separate `CanvasSink`. Each uninterrupted playback generation owns a separate two-canvas pool, reused throughout that playback. A late conversion from a retired request therefore cannot overwrite the pixels of the current generation's held next frame before its generation check runs. Single-frame retrieval closes its decoded sample; retired playback iterators are returned. `CanvasSink` itself has no disposal method.
