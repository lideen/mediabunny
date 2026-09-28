# Default WASM numerical migration

The private package now uses `h262-butterfly-q14-q5-v1`. The user authorized this
numerical change after disclosure of changed rounding, predictive drift and incomplete
IEEE qualification. Native f64 is unchanged. The adapter, automatic thread sizing,
direct/serial-worker/pool APIs, transport, cancellation and memory budgets are unchanged.
There is no runtime IDCT selector or fallback to old pixels.

## Identity and source state

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Scalar WASM | 144238 | `c06ed93c42aa17dfe45bcad2e55b6d14fca5e0c07b5bca1cc469b52999407b9b` |
| Shared WASM | 332988 | `32270a44364331fe90b2d22aeb590471c767a0bf4bd5c2e4e6346561e6ef7281` |
| Final numerical manifest | See manifest | `6ea6cb87b90ba047924ca524c2d429ece1466c72d1d3a2c43a4662d25957a3dc` |

The reviewed source commit is `3ccd64065dd45e6675b0a3602d1804315935b515`, matching
all 565 final snapshot source identities. The original build snapshot was based on
`1fafe8f611afab696ce8b90d2d54b46f4c252789`. The clean source patch
has SHA-256 `15736878317bef392bcea7b7c34450217295dcada61b6fb9747a2cf3d6d09080`.
It contains no ANSI escapes and passes `git apply --check` against that canonical base.
The final handoff changed only two post-build tools, the packager and regression
recorder. Compiled source, binaries and qualification evidence did not change.

`vendor/threads/provenance/numerical/` retains the supplied manifest, original build
records, qualification evidence and core report. `provenance/previous/` retains
the previous scalar/shared provenance; `threads/INPUT-MANIFEST.json` is explicitly
historical. Dependency licenses and the controlled Rayon helper adaptation are unchanged.
Every generated JS file, declaration, facade and coordinator matched the previous
consumer byte-for-byte. Only two runtime binaries changed.

All assets remain private and UNLICENSED for distribution. No publication or project
license decision is implied by vendoring the new artifacts.

## Regression records and test migration

The old FAANI, native and f64 fixture references remain unchanged. PCM hashes, packet
bytes, timing, order, metadata and algorithm-independent pixels retain their old
expectations. `test/fixtures/mpeg2/wasm-idct-v1.json` is a separately labeled consumer
regression record, not an independent mathematical accuracy oracle.

The consumer wrappers do not all match the core fixture input hashes. Their new records
bind wrapper SHA-256, complete demuxed packet hashes and timing, ordered frame hashes,
qualified WASM identity, old frame/plane hashes and signed drift histograms. The recorder
decodes the exact packets with the already-qualified standalone core artifact first,
then checks the actual built consumer output against it. It does not bless whatever
the consumer happens to emit. Live, Cosmos and long-IPB essence also match existing
qualified workload records. No tolerance matcher or regeneration of independent
goldens was introduced.

| Assertion owner | Intentional change | Preserved checks |
| --- | --- | --- |
| `test/node/mpeg2.test.ts` | Scalar binary identity and progressive plane hashes use v1 records | Original timing, PCM, errors, ownership, close/init and 90-packet lifetime checks |
| `test/node/mxf-mpeg2-open.test.ts` | Progressive open-GOP frame hashes use v1 records | Packet manifest, dependency/preroll checks and unchanged independent woven-interlaced hashes |
| `test/node/mxf-mpeg2-lifecycle.test.ts` | Expected selected hashes use the same open-GOP v1 record | Asynchronous initialization, release, queued header discards and timing |
| `test/node/mxf-mpeg2-cutoff.test.ts` | Selected backward-only B uses its qualified wrapper regression | The 127-decode-ordinal dependency edge and all negative cases |
| `test/node/mxf-mpeg2-progressive.test.ts` | Padded High and High-1440 hashes use v1 records | Geometry, packet/audio timing and unsupported dependency checks |
| `test/node/lxf.test.ts` | The authored all-I wrapper uses its qualified wrapper regression | Eight-channel PCM values, timing, endpoints, ownership and wire validation |
| `test/browser/mpeg2-worker.test.ts` | Progressive plane hashes use v1 records | Independent woven-interlaced pixels, clones, cancellation and terminal transport failures |
| `test/browser/mpeg2-threads.test.ts` | Held progressive clone uses v1 hashes | Coordinator/pool termination, partial startup failure and no fallback |

The baseline targeted Node gate passed 465 tests with 10 skips. Before migrating
expectations, the new artifact produced 16 failures, all at changed pixel assertions.
The later lifecycle/audio assertions were rerun after migration rather than left
unreached behind the first changed pixel.

Final validation passed `check`, lint, library build, examples build, all 465 targeted
Node tests with the same 10 skips, six existing serial-worker browser tests and four
existing pool browser tests. The 48 ESM/global and direct/worker/2/4 cases matched
qualified core pixels for 1,664 full frames, 192 selections and 48 held clones.
Video metadata and all 392 available audio packets and decoded PCM samples matched
the frozen old consumer. Automatic selection passed 24 cases; 22 lifecycle and 10
terminal cases retained explicit capability/CSP failures with no fallback.

## Additional observed predictive drift

The authored `open422.mxf` fixture adds the same residual through three P pictures.
At luma offset 565, old/new values are:

| Picture | Old f64 WASM | Butterfly WASM |
| --- | ---: | ---: |
| I2 | 119 | 119 |
| P5 | 141 | 142 |
| P8 | 163 | 165 |
| P11 | 185 | 188 |

At this zero-motion sample, successive anchor pixels increase by 22 with the old
decoder and 23 with the butterfly. The authored prediction/residual syntax supports
interpreting this as repeated residual rounding differences accumulating to +3.
This is inferred from source and decoded pixels, not a captured internal residual
trace. Corresponding backward-predicted B samples also show +3. Across this fixture,
71 samples in six frames differ by +3. The standalone qualified core and consumer
agree on identical packets. Full histograms and affected offsets are retained.
The woven interlaced fixture is unchanged. This is not independent transform-accuracy proof.

Core qualification covers 83,773 blocks and 5,361,472 residuals. Exact DC/F63 and
half-boundary checks, engineering groups and the reported H.262 subsets passed.
IEEE 1180 A2 qualification is incomplete; A3 accuracy is sampled, not exhaustive.
There is no IEEE or full H.262 certification. Previously observed media drift of 2
and this authored drift of 3 are not bounds for unseen streams or longer prediction chains.

## Retained consumer evidence

The owned local evidence directory is
`mpeg2-butterfly-consumer-20260928` under the approved OpenCode temporary root.
It contains the frozen `a63e1ff5c0b7339bbdb6cea2ea8e99ba8c512e67` production bundles,
input fingerprints, standalone-core comparison scripts, old/new regression records,
browser traces, validation commands and cleanup records. Only retained captured/authored
inputs were used; no original media, CDN or network media downloads were read.

The consumer measurement boundary is the whole public `VideoSampleSink` lifetime,
including Input setup, lazy runtime loading/initialization, output copies, sample
disposal and observed worker termination calls. Media loading/hashes, host-bundle
imports and rendering are outside timing. HTTP responses use `Cache-Control: no-store`;
the browser is reused and engine code caching is not measured. Picture-call and
first-output times are distinct from whole-lifetime wall time. These 18–60-frame
selections do not establish original-file EOF, sustained playback, rendered quality,
heap reclamation or A/V quality.

### Public-sink measurements

Fresh old/new production bundles ran serially on the same host. Each mode/workload
used five warm ABBA rounds and seven measured ABBA rounds, giving 14 observations
per artifact. Explicit direct and four-thread choices avoided policy differences.
The unchanged host core bundle was shared by both artifacts. Positive reductions
below mean less whole-lifetime wall time. Percentages are the median of seven
paired-round reductions, not ratios of the two independently summarized p50s.
Percentiles use `sorted[floor((n - 1) * p)]`, not interpolation or nearest-rank p95.

Each ABBA slot navigated to a fresh page, then ran SWAT, Live, progressive, Cosmos
and long-IPB in that order. Runtime imports/compilation on first use were inside
timing; later workloads in that page could reuse realm-cached modules. Each decoder
still owned fresh references and, in pool mode, fresh coordinator/pool workers.
HTTP `no-store` does not disable this JavaScript module cache or engine code caching.

| Mode | Captured/authored selection | Old/new wall p50, ms | Paired reduction | Round range |
| --- | --- | ---: | ---: | ---: |
| Direct | SWAT, 30 frames | 844.18 / 668.34 | 20.43% | 19.23% to 22.77% |
| Direct | Live, 32 frames | 915.99 / 649.73 | 29.12% | 27.96% to 29.55% |
| Direct | Long IPB, 60 frames | 391.80 / 364.16 | 7.16% | 6.46% to 7.99% |
| Direct | Cosmos, 32 frames | 62.44 / 62.87 | -1.84% | -7.28% to 0.57% |
| Direct | Progressive, 18 frames | 31.26 / 31.42 | -0.83% | -24.64% to 5.62% |
| Four threads | SWAT, 30 frames | 314.27 / 291.31 | 9.15% | 8.12% to 9.82% |
| Four threads | Live, 32 frames | 320.60 / 274.80 | 13.45% | 11.05% to 15.96% |
| Four threads | Long IPB, 60 frames | 219.96 / 217.42 | 0.01% | -1.13% to 3.47% |
| Four threads | Cosmos, 32 frames | 64.81 / 66.60 | -1.05% | -13.37% to 5.38% |
| Four threads | Progressive, 18 frames | 40.70 / 43.46 | -2.68% | -6.32% to 12.64% |

Direct SWAT/Live first-output p50 changed from 62.81/44.70 ms to 48.02/31.05 ms.
Four-thread SWAT/Live first-output p50 was 45.41/32.98 ms before and 47.28/31.25 ms
after. Startup is therefore not interchangeable with the whole-lifetime gain.
The median per-burst public iterator-call p95 changed from 30.85/31.99 ms to
24.36/22.98 ms in direct mode, and 9.96/9.82 ms to 8.87/8.21 ms with four threads.
An iterator call is not necessarily one decoder picture call because pictures can
be delayed or drained. Neither measure includes rendering.

Four-thread module initialization p50 was about 4.3 to 5.0 ms and pool startup about
8.4 to 9.6 ms. Whole-lifetime timing also includes approximately 1.4 to 2.1 ms of observed
termination waiting. These observations establish neither cold-browser startup nor
heap reclamation. Short progressive/Cosmos runs did not show a consistent gain.
The earlier isolated kernel measurements are not consumer performance claims.
