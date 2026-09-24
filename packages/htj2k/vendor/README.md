# Pinned OpenHTJS runtime

Upstream project: https://github.com/sandflow/openhtjs

This snapshot is from the prepared OpenHTJS branch `feat/reproducible-wasm`, commit `6e4f36f11db5c532c4a9a180a5e83ffdd7cd2c25`. That commit is not assumed to be available on the upstream remote. `openhtjs-source.tar.gz` includes the exact build inputs from that commit: `CMakeLists.txt`, `Dockerfile`, `LICENSE`, `.gitmodules`, `patches/`, `src/cpp/`, `src/js/`, and `scripts/build.sh`. It excludes demonstration imagery and the OpenJPH submodule. The archive is produced with `git archive <commit> <paths> | gzip -n`.

Source archive SHA-256: `2dbeba39a07fcd9485b0624a7dc4363569eb6184009d705c1a436e7cba0b4037`.

Dependencies:

- OpenJPH 0.32.0, commit `23c422895ce6c3a156935222e4715ee0b7be952c` from https://github.com/aous72/OpenJPH
- Emscripten 6.0.10, Docker image `emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65`

Runtime files are unmodified build outputs:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| HT_internal.js | 23443 | `fe63275c3da9f631c127db1951cf953c48dc29125c2580b6cb91fdfab06b5a28` |
| HT_internal.wasm | 136767 | `db0e4de4f4b5c2f52ec7eb9003d88fddcef717ed9040e006002664d62abdea2d` |

The package uses the module factory directly instead of OpenHTJS's top-level-await `HT.js`. It supplies `instantiateWasm` with the bundled bytes and translates the native checked bindings' returned `Error` objects into thrown errors. `wasmBinary` is not an incoming option in this optimized build. The handwritten `HT_internal.d.ts` describes only the factory and methods this package uses.

The wrapper retains OpenJPH's strict default rather than enabling resilience. Corrupt packet data must reject decoding instead of returning concealed pixels. The public sample-sink regression exercises a truncated packet with otherwise consistent frame boundaries and verifies that a later valid input still decodes.

## Rebuild

Run in a disposable directory with Docker available:

```sh
tar -xzf /path/to/openhtjs-source.tar.gz
git clone https://github.com/aous72/OpenJPH external/OpenJPH
git -C external/OpenJPH checkout --detach 23c422895ce6c3a156935222e4715ee0b7be952c
sh scripts/build.sh
shasum -a 256 dist/HT_internal.js dist/HT_internal.wasm
```

The Dockerfile applies the included decoder-only patch in the container, not to the host checkout. It builds scalar WASM with exceptions and bounds checks. Replace both runtime files together only after matching their hashes and rerunning the package tests. Runtime distribution does not depend on an absolute local path or an unpublished npm dependency.

## Licenses

`LICENSE` is the OpenHTJS MIT license. `LICENSE.OpenJPH` is the BSD-2-Clause OpenJPH license. The remaining `LICENSE.*` files contain Emscripten and linked runtime notices from the pinned toolchain. The package ships every notice in this directory, and `scripts/bundle.ts` includes them in all extension bundles, including minified bundles. Mediabunny's adapter remains MPL-2.0, with its license at the package root.
