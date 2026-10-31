# Synthetic Dolby Vision fixture

`dolby-p8.mp4` is a 160x90, 24 fps, 12-frame FFmpeg `testsrc2` pattern encoded
with x265 4.3 as Main10/PQ/BT.2020. It contains one valid Profile 8 RPU per frame
and an explicit `dvvC` Profile 8.1 / Level 1 / BL+RPU configuration box.
It tests parsing, remux preservation and filter execution, not creative fidelity
or Dolby certification. No commercial video imagery is included.

The RPU bytes come from `assets/tests/profile8.bin` in
https://github.com/quietvoid/dovi_tool (MIT; see `dovi-LICENSE.txt`). The same RPU
was repeated for the 12 synthetic frames. The MP4 configuration box is explicitly
set because raw HEVC does not carry a container's Dolby configuration record.

`dolby-p5.mp4` uses the same synthetic pattern with x265 Profile 5, full range,
the upstream `assets/tests/profile5.bin` RPU repeated per frame, and a `dvh1`
sample entry with `dvcC` Profile 5 / Level 1 / compatibility ID 0. It exercises
RPU-based color reconstruction and proves the filter does not use a PQ base-layer
fallback for Profile 5. The pattern is not a calibrated artistic reference.

Production never injects configuration boxes or sidecar RPU into uploads; this
construction is exclusively a test fixture. Its decoded frames expose actual
Dolby Vision Metadata, and the integrity tests compare the full RPU NAL sequence.
