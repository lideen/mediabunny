# Synthetic HTJ2K fixtures

`rgb8.j2c` and `rgb16.j2c` are original 8×4 patterns from OpenHTJS commit `a0e1dbbd68e9e4be6beec50abf15ea792fe19f51`, covered by the accompanying MIT license. No demonstration-media imagery is included.

Each of the four rows contains RGB values:

```
0,0,0  255,255,255  255,0,0  0,255,0  0,0,255  17,83,201  128,64,32  254,1,127
```

The 16-bit fixture multiplies each value by 257. Both use reversible OpenJPH 0.32.0 encoding, one decomposition, one full-frame tile, and one quality layer. RGB8 uses the reversible color transform; RGB16 does not. Expected decoded pixels in tests are these original patterns, not output from the decoder under test.

`rgb16.mxf` wraps five copies of `rgb16.j2c` at 24 fps in synthetic metadata for browser tests. Regenerate it from the repository root:

```sh
npx tsx -e "import {makeMxf} from './test/node/mxf-fixture.ts'; import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync('test/fixtures/htj2k/rgb16.mxf',makeMxf({htj2k:{data:readFileSync('test/fixtures/htj2k/rgb16.j2c'),bits:16},videoOnly:true,editRate:[24,1]}).data);"
```
