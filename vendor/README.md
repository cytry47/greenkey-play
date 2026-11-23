# Vendored libraries (no CDN at runtime)

| File | Library | Version | License |
|---|---|---|---|
| mp4box.all.min.js | mp4box.js (GPAC) | 0.5.2 | BSD-3-Clause, LICENSE.mp4box.txt |
| webm-muxer.js | webm-muxer (Vanilagy) | 5.1.4 | MIT, LICENSE.webm-muxer.txt |

## Local patches to webm-muxer.js (search `GREENKEY PATCH`)
1. `addVideoChunkRaw`: `meta.alphaSideData` is written as BlockAdditions > BlockMore (BlockAddID 1, BlockAdditional),
   the Matroska way to store VP8/VP9 alpha. Upstream 5.1.4 only sets AlphaMode and drops the alpha data.
2. Delta frames inside a BlockGroup get `ReferenceBlock = -1`, so not every frame reads as a keyframe.
3. `finalize`: Segment Duration = max(last timestamp, `muxer.endTimeMs`), so the file lasts until the END of the last
   frame (upstream writes the last frame's START, one frame short).
