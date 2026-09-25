# Media-player example

Build with `npm run build`, start `npm run dev`, and open `/examples/media-player/`. The player accepts local files and remote URLs, including experimental MXF input. Optional decoders are registered in `media-player.ts`.

## Finite HTTP ranges

Open `/examples/media-player/?minimumRequestSize=32768` to opt remote URL loads into `UrlSource`'s finite-range policy with a 32 KiB request floor. The parameter belongs to the example page URL, not the media URL. `UrlSource` validates the numeric value; invalid values appear as a load error. Local file loads are unaffected. Omitting the parameter preserves the default adaptive transport, which may issue open-ended requests.

This setting is useful for servers that require finite byte ranges and for measuring remote-media access. It is not a per-request maximum or a total transfer budget: large packets can require larger requests and the source can read ahead. Use an independent server-side budget when inspecting large remote files. The player does not synthesize missing bytes or disable normal sink backpressure.

## Paused previews and playback

For explicit HTJ2K reduced decoding, add both `decodeWidth` and `decodeHeight`, for example `/examples/media-player/?minimumRequestSize=32768&decodeWidth=480&decodeHeight=270`. Remote reduced loads require a finite request floor before any metadata is read. Unsupported codecs, layouts, and requests that require full resolution report an error instead of falling back. The URL must remain immutable; this example does not verify ETags. The server must honor finite Range requests and expose Content-Range through CORS. This option is independent of canvas display dimensions and is off by default.

Loading and seeking while paused use `CanvasSink.getCanvas(timestamp)`, without starting a sequential video iterator or an audio iterator. Inter-frame codecs still require their normal decoding dependencies. Play starts the existing buffered video/audio iterators; pause and seek return them and invalidate pending work before requesting a new preview. An in-flight read or native decode can finish, but an obsolete generation cannot draw, schedule audio, or restart playback. Playback and seek errors appear in the player's error element.

Each paused request owns a separate `CanvasSink`. Each uninterrupted playback generation owns a separate two-canvas pool, reused throughout that playback. A late conversion from a retired request therefore cannot overwrite the pixels of the current generation's held next frame before its generation check runs. Single-frame retrieval closes its decoded sample; retired playback iterators are returned. `CanvasSink` itself has no disposal method.

## Buffered smooth HTJ2K mode

Open `/examples/media-player/?smooth=1&minimumRequestSize=32768` for opt-in, video-only HTJ2K playback. This example currently requires 16:9 coded video at 24 fps (24/1, not 24000/1001). It rejects other aspect ratios, audio tracks (including unsupported ones), live input, and combinations with fixed `decodeWidth`/`decodeHeight`. Remote loads still require the finite range policy before metadata discovery. Normal AVC/AAC playback and fixed-quality mode retain their existing paths.

This mode starts with a 120×68 minimum request and may select 60×34, 240×135, or 480×270. These are minimum requests, not arbitrary resizing: actual native dimensions depend on source geometry and decomposition levels and are shown in the player. Samples larger than 480×270 or requiring complete-resolution decoding are rejected. The canvas retains the original display size and draws through the public sample API. Lower resolution preserves exact quality at that native level, not the detail of a higher-resolution frame.

Only remote input with `?smooth=1&minimumRequestSize=32768` sets `UrlSource.parallelism` to 48 before metadata discovery. Normal and fixed-resolution input retain the default two workers. A shared example-local concurrency constant also limits metadata lookahead to 48 active operations on the same track and Input. The controller selects a 104-frame horizon for 60×34 and 120×68, and 72 frames for 240×135 and 480×270. The low tier requests 16,409-byte container windows; all other tiers request 65,536 bytes. The codec-neutral helper accepts the byte hint and horizon separately. The horizon follows the next frame to display, not the producer's tail. Completed entries leave the helper as playback advances. Source workers are shared with payload requests; this does not create 48 decoders or change the core's two reduced-preparation slots. Physical responses may continue draining after logical cancellation, so 48 is not a hard bound on physical requests across retiring generations.

That query combination also uses `requestInit: { cache: 'no-store' }` to bypass the browser's HTTP cache. Otherwise, Chrome can serialize simultaneous Range requests to the same URL while waiting for response headers, even over HTTP/2. Mediabunny's own Source cache remains enabled. This setting may affect request headers and intermediary cache behavior; local overlap is not evidence of CDN cache-hit behavior.

Lookahead validates 24/1 CFR timing from the first two metadata-only packets and the known metadata end time, without a frame-rate scan. Other cadences reject before lookahead fanout because the admission horizons are sized for the three-second buffer at 24 fps. Every future packet must match the expected PTS, duration, key status, and sequence number. Queries use an interior timestamp to avoid selecting the preceding frame through floating-point rounding. Known EOF bounds stop admission before a repeated last packet could be mistaken for a new frame. Unknown duration and incompatible timing reject rather than guess.

The producer waits only for its next required metadata result, not the entire window. Quality switches retain lookahead because packet locations are quality-independent. Pause, seek, reload, and errors abort the generation through the public packet-retrieval `signal` option and settle its lookups. Completed shared MXF metadata may remain cached for later consumers. The Source cache retains its existing 64 MiB limit; metadata maps, core lookahead, and native allocations remain separate from the decoded FIFO cap. More overlap addresses cold per-frame request latency, but neither 48 workers nor buffering guarantees sustainable CDN throughput or 24 fps. Local timing models do not establish shared-link or remote contention capacity, and higher-quality original-CDN playback remains unvalidated.

Each admitted metadata lookup uses the public `prefetchBytes` hint: 16 KiB plus 25 bytes at 60×34, or 64 KiB total
at higher tiers. The hint includes the container header. Unambiguous indexed MXF layouts can read the header and
prefix together, clamped to the file, body partition and available edit-unit bounds. Ambiguous layouts use ordinary
header reads. Cached locations may omit prefetch, including after pause/resume. The example does not separately
call `prefetchPacketRange` or retry warming. Metadata readiness includes the combined read's completion.
These hints do not prove complete codestream coverage. The decoder still validates every required byte and fetches
any missing ranges through the same Source, with two preparation slots and no complete-frame fallback.

Lookahead reserves at most 64 KiB per entry and 6.5 MiB (6,815,744 bytes) across pending and retained entries, including header allowance. This adds 2 MiB of possible speculative prefix work to the previous budget; it is not a download allowance or a process-memory cap.
Pruning aborts a pending demand but keeps its reservation until settlement. Quality changes affect only future
admissions and immediately reconsider admission, even without a display advance. Existing entries keep their original
hint and reservation. An upgrade retains useful entries beyond the smaller horizon and waits for display progress
before admitting more; it does not cancel and rewarm them. The budget is checked before every new admission, so
retained high-tier entries can truncate the speculative low-tier tail. Pause, seek, reload and error settle the generation,
including pruned pending tasks. This logical cap
excludes the Source cache, stable reader copies, native memory and additional physical Source work. Source worker
reuse can bridge gaps, particularly for CustomSource; the hint bounds the demuxer's requested window, not universal
physical traffic. The example's bounded UrlSource uses zero gap tolerance. Already-sent canceled requests remain
traffic costs. Neither the hint nor this reservation cap is a whole-playback download budget.

Playback waits for two seconds of contiguous decoded samples, fills to a three-second high-water mark, and displays at most one consecutive sample per render opportunity. Starvation freezes the clock and refills before resuming. A late render reanchors the clock instead of discarding overdue frames. At EOF, remaining samples play without requiring the startup threshold. This favors continuity over keeping up with wall time when the browser or network cannot sustain the source cadence; it does not guarantee 24 fps.

The controller owns a FIFO of `VideoSample`s, closes every displayed or discarded sample, and limits owned decoded storage to 32 MiB. Accounting uses each sample's actual allocation and includes a maximum-sized RGBA reservation while a sample request is pending. Core sink lookahead, preparation buffers, Source caches, canvas storage and WASM are additional memory. The status line shows state, actual resolution, buffered seconds, owned bytes including reservations, and render lateness. Network traffic is not limited by the decoded-storage cap.

Quality uses a batched, smoothed fill-rate measurement excluding high-water waits. Initial 120×68 playback is protected from rate-based downgrade until readiness or six seconds from Play intent. Render ticks check readiness first; otherwise the deadline lowers the next producer to 60 even if no rate batch or sample has completed. Six seconds bounds tier patience, not startup completion. Producer replacement does not renew it. Pause/dispose retires the intent; a new Play gets a new window at its existing tier, without promoting 60 back to 120. A resumed seek starts the window at the seek's resume intent, before cleanup and preview; a paused seek starts none until Play.

The first transition to playing for that intent clears the startup EWMA and partial fill-rate batch, including a pending sample wait that crosses the reset. Rebuffer recovery does not clear steady-state history. Declining buffer below half a second and insufficient rate lower the next producer's tier. Other startup/refill quality decisions retain the two-second insufficient-rate rule. Upgrades still require five continuous seconds above 1.5 seconds buffered, a conservative 5× fill rate, and a ten-second switch cooldown. Changes retain queued samples, finish canceling the previous producer, then start at the next unadmitted timestamp. They do not skip a gap or reinterpret an incomplete prefix as a frame.

Pause stops production and discards queued samples, preserving the displayed timestamp. After 200 ms it may refine that same frame with a 480×270 request. Play, seek, and reload cancel refinement; stale samples cannot draw. Resume begins at the displayed frame's end. Seeking replaces the playback generation and either displays one paused target or starts buffering according to the prior play intent.
