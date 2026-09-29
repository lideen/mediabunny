# MPEG-2 consumer qualification

## Scope and status

The v1 target is HD, 8-bit 4:2:0/4:2:2 frame pictures through the existing opt-in MXF subset. Interlaced output is woven at frame rate. `VideoSample.scan` retains top/bottom field order; canvas conversion does not preserve scan metadata or deinterlace. Separate field pictures, repeated-field cadence, 4:4:4, scalable coding, Sony D-10 and 4K are outside v1. LXF retains its separate narrower input contract.

Functional evidence is not production readiness. IEEE 1180/H.262 A2 remains UNVERIFIED. Existing numerical regression hashes do not establish accuracy. The final local replay below includes 120-second paced and player runs, not production memory, compositor presentation, acoustic A/V sync or realistic in-flight abort-latency acceptance.

## Rerun the exact consumer

Use the repository's Node/npm environment, FFmpeg/ffprobe and Chrome with a matching ChromeDriver. Process-group cleanup requires a POSIX host, such as macOS or Linux. `CHROME_PATH` and `CHROMEDRIVER_PATH` can select explicit local executables. The recorded host used Node 24.16.0, FFmpeg 7.1.1 and Google Chrome 154.0.8037.58 on Apple M3 Pro. Neither Safari nor Firefox was run. Use isolated browser sessions only.

```sh
npm ci --no-audit --no-fund
npm run pre-test
# Choose a NEW output directory. Default generation is one 30-second 720p25 sequence
# plus two 2-second 1080i50 top/bottom-field-first sequences, all with generated PCM.
python3 test/node/generate-mpeg2-qualification.py "$EVIDENCE/media" 30
npx tsx scripts/qualify-mpeg2.ts \
  --media "$EVIDENCE/media" --out "$EVIDENCE/consumer-functional"
```

The CLI validates the complete supplied artifact, builds core and the MPEG-2 adapter, and runs the existing Vitest/WebdriverIO browser runner against those staged bundles. It also builds the actual media-player example. Decoder selection is checked in esbuild's input graph, then both WASM payloads are independently located and hashed in the extension and resulting player JS. The vendor tree is never rewritten by qualification.

Both entry points validate the manifest before decoding. The required matrix is exactly `progressive420`, `top422` and `bottom422`, with no empty, duplicate or missing cases. Dimensions, format, scan, media filenames, positive integral duration/frame counts, all packet timestamps/durations/SHA-256 values and the first/middle/last reference filenames must match the generator contract. Functional runs require 30 to 120 seconds of progressive material. Paced runs require 120 seconds. Both interlaced cases remain two seconds. The generator accepts 30 to 120 seconds; longer runs are not currently supported by this command.

For a source-build candidate, pass the complete standalone artifact directory. It must include `PROVENANCE.json`, runtime modules, generated types, package marker, notices and licenses. No private remote clone or credentials are assumed by this command.

```sh
npx tsx scripts/qualify-mpeg2.ts \
  --decoder /absolute/candidate/package/dist \
  --media "$EVIDENCE/media" --out "$EVIDENCE/candidate-functional"
```

`identity.json` records source-file identities, decoder MJS and embedded WASM hashes, consumer/core/player bundle hashes and media-manifest identity. `decoder-provenance.json` retains the supplied producer source/build records. `metafile.json` proves the chosen build input. `report.json` joins these identities to the browser's assertions; `vitest.json` and `functional.log` retain runner results and failures. A self-consistent candidate manifest establishes identity, not independent trust or approval. Normal builds additionally enforce the approved import pin.

### CI report contract

`report.json` has `schema: 1` and these join fields:

- `passed` is true only when the runner exits successfully, emits its completed matrix observation and has no timeout, interrupt, startup or cleanup error. It means functional assertions passed, never real-time acceptance.
- `scope.kind` is `mpeg2-consumer-functional`; `scope.matrix` lists the three required names. `scope.paced` identifies pacing, `scope.minimumContinuousSeconds` is 30 or 120, and `scope.realTimeAcceptance` is always false.
- `identity.decoder.sha256` identifies the supplied standalone MJS. Join this exact value to decoder CI. `identity.embeddedWasm.scalar/shared` and `identity.consumer/core/playerBundles` carry `{ bytes, sha256 }` identities.
- `observations.results` contains one result per required case, including `name`, `frames`, `packetCount`, `lastTimestamp`, `audioFrames`, `continuousMs`, `renderErrors`, `abortSettlementMs`, `ownedPlaneSurvivedDisposal`, `lateFrames` and `maxLatenessMs`. Unpaced lateness fields are null. The parent must evaluate paced lateness separately; no acceptance threshold is applied here.
- Preflight rejection writes `passed: false`, `identity: null`, `observations: null` and `failure: { phase: "preflight", message }`. A runner failure retains available identity and observations, with `runner.status`, `runner.termination`, `runner.timeoutSeconds`, optional `runner.spawnError` and `runner.cleanupErrors`. `runner.termination` is null, `timeout`, `SIGINT` or `SIGTERM`. Cleanup also records `processGroupId`, `remainingProcessIds` and `cleanupWarnings`. A signal error against an already-exited group is only a warning when process inspection independently confirms no live members.

Vitest runs in a new owned process group with a 420-second deadline covering browser startup, testing and teardown. On timeout or SIGINT/SIGTERM, the CLI sends SIGTERM to that group, escalates to SIGKILL after two seconds if necessary, and kills remaining group members after runner exit. A bounded process-table check verifies that no live group members remain. It retains the raw log and failed report. `--timeout-seconds 1..420` can shorten this deadline for diagnostics. CLI regression tests exercise a stalled driver and its child through the actual entry point, including timeout and interrupt cleanup. No existing browser session is attached or killed.

The browser test compares all demuxed coded packets to FFprobe SHA-256 and timing, consumes every decoded frame without resetting the chain, checks timestamps/geometry/scan and EOF, renders each output, and compares first/middle/last canvas pixels to independently generated FFmpeg FAANI RGBA. The RGB mean-absolute-error threshold of 6 sample units is a color smoke threshold, not an IDCT conformance limit. Backward seeks after EOF must reproduce sequentially decoded owned-plane hashes. One held plane copy must survive subsequent decoding, seeks and input disposal. Every delivered sample is closed immediately. Generated PCM frame counts and timestamps are checked, but this is not acoustic A/V sync.

The final selection cancellation assertion checks immediate cancellation and reports settlement time. Existing serial/pool lifecycle tests own cancellation during initialization, decode and finish. None of these timings prove interruption within synchronous native decoding.

## Quiet-window and player checks

After other CPU work stops, generate 120 seconds and rerun with `--paced`. This paces a single sequential sample iterator at media timestamps, reports frames more than 40 ms late and maximum lateness, and retains bounded output. It does not simulate the example player's audio clock or compositor. A passing paced report is still only a functional result with lateness observations. Use `--serial` in a separate run to disable cross-origin isolation; omission exercises automatic isolated execution.

Add `--serve` to keep an owned loopback, ephemeral Vite preview server running after a passing test. This explicit interactive server is outside the Vitest deadline and runs until SIGINT/SIGTERM. Open its printed URL at `/examples/media-player/` in a fresh named agent-browser session. Load `/media/progressive420.mxf` through the URL button. Use Space for play/pause and arrows for five-second seeks. The current example has no frame-step UI; sink timestamp selections cover exact frame selection instead. Test uninterrupted playback to EOF, backward seeks, pause/resume, replacement with top/bottom-field-first material and cancellation/rejection. Stop this server and browser when finished.

Keep Chrome version, consumer hash and action trace with observations. A canvas `drawImage` observer can count submitted draws and compare the final canvas bytes to the supplied RGBA reference. Draw counts are not compositor presentation counts. An `AudioBufferSourceNode.start` observer can record scheduling and PCM RMS without retaining audio buffers; it does not measure acoustic output. `performance.memory` excludes worker/native/GPU memory. Worker termination calls and freed sample handles are not proof of heap reclamation. Do not turn these proxies into dropped-frame, A/V-sync or memory acceptance claims.

## Retained functional run, 2026-09-29

Evidence is local under `opencode/mediabunny-mpeg2-readiness-20260929`; no media is committed or published. The approved `8f7b6e99…` artifact passed 117 existing Node tests, the serial-worker five-test group and the isolated-pool two-test group. The artifact guard separately rejected an incorrect pin, a modified module and a rehashed module with an incorrect embedded WASM payload.

`functional-3` decoded 750 uninterrupted 720p frames and 50 frames of each 1080i field order. Last timestamps were 29.96 and 1.96 seconds. Every coded-packet hash matched FFprobe. Selected rendered RGB mean errors were 1.23 to 1.42 for 4:2:0 and 0.72 to 0.76 for interlaced 4:2:2. Final serial and explicit-artifact-override runs repeated these assertions with the portable CLI and emitted joined `report.json` files. These runs were unpaced and under concurrent host load; elapsed/abort observations are not representative latency results.

The actual built player completed 30 seconds with 750 playback draw calls plus the paused preview, 750 scheduled PCM chunks totaling 30 seconds, no reported error and final-frame RGB mean error 1.42. Backward selection to 15 seconds matched its reference at mean error 1.38; resume/pause and replacement with bottom-first 1080i completed without a reported error. There is no acoustic-sync or compositor-drop result. Main-realm heap observations alone do not establish a memory bound.

A retained 7.2 MiB SWAT MXF selection also reached its last frame, RGB mean error 0.31. The final replay below explains its 29 draws. The earlier 12 MiB LXF URL attempt failed without a finite `UrlSource` range policy; that failure remains retained alongside the successful retry. Full customer originals were not loaded. These bounded checks do not qualify the multi-gigabyte source movies.

## Final source-build replay, 2026-09-29

Local evidence is under `opencode/mpeg2-readiness-integrated-20260929`. See `REPORT.md`, `summary.json` and `parent-*-gate.json` for commands, identities, failures and limitations. Qualified source commits precede this documentation-only update:

- Decoder: `36aa6fd041278d6cab1a5de7198861ef72c5ee95`.
- Consumer: `a8bf6e7d7114bbc0d8a3994a68c7ef526b94d384`.
- Fresh candidate MJS SHA-256: `c7fb9839c44e8a4a7cc7adc911c8b4f6f0b381905c4ddc447af78522eec0a1a1`.

Local engineering and consumer-functional gates passed, including independent parent gate reruns. The 132 Node, five serial-worker and two pool regression tests use approved artifacts, not fresh-candidate proof. Explicit candidate runs passed isolated and nonisolated paced matrices with 3,000 progressive and 50 pictures per field order. Maximum lateness was 109.015 ms isolated and 69.900 ms serial, above the 40 ms period, not a zero-lateness pass.

The actual player twice reached EOF after 120 uninterrupted seconds, each with 3,000 playback draws plus preview and 3,000 scheduled PCM chunks. Observed summed browser RSS peaked at 1,740,944 KiB and may double-count shared pages. Main-realm heap grew; this is not leak-free or reclamation proof.

SWAT's 29 draws reflect playback starting at the first coded PTS, 80 ms, skipping earlier B-picture PTS 0/40 ms. They are not evidence of scheduler drops or independent decodability of those leading pictures. LXF reached EOF using finite 32 KiB requests and HTTP 206. This is bounded playback evidence, not full-format numerical qualification. No frame-step UI was added.

Production readiness remains blocked. IEEE 1180/H.262 A2 needs authoritative-text review or a normative replacement; `--require-a2` still exits 2. Hosted Linux CI, private-checkout credentials and an immutable consumer ref remain unconfigured/unpushed. Acoustic A/V sync, compositor drops and whole-process memory have no acceptance pass. The support target remains narrow Chrome HD v1.
