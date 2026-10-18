# Screenshot Plus: HDR session notes (Claude, 2026-10-17)

> **Update, round 2 (same day).** The user reported: YouTube still not HDR;
> video still greenish on the phone; Ultra HDR photo now shows as HDR but is
> "greenish like the video". So I ran the extension in a real GNOME Shell 50.1
> session and measured its output. See **Round 2** at the end, which
> supersedes the guesses about the green tint below.

Context for the next person or session working on HDR in this extension.
Setup reported by the user: GNOME 50, **Intel integrated graphics** (iHD VA-API
driver), screen in HDR mode. A patch of everything below against the original
upload is in `../screenshot-plus-hdr-fixes.patch`.

## The three reports, and what was found

### 1. YouTube doesn't treat HDR recordings as HDR

YouTube's rules (support.google.com/youtube/answer/7126552): the file **must** be
tagged BT.2020 primaries + PQ/HLG + BT.2020 non-constant matrix, 10-bit, at a
standard frame rate (23.976–60). Mastering-display/MaxCLL data is only
recommended; without it YouTube assumes a Sony BVM-X300.

Found by rebuilding the mux and remux steps (GStreamer 1.24 `mp4mux`/`webmmux`,
then the extension's exact ffmpeg command, ffmpeg 6.1):

- **The remux dropped the container colour.** `mp4mux` writes a correct `colr`
  box (nclx 9/16/9, limited). But ffmpeg's probe replaces the container colour
  with what the *bitstream* says before the bitstream filters run, which is
  "unspecified" (the VA encoders write no colour description). `-c copy` then
  writes **no `colr` box** in MP4, and **matrix BT.709** in the WebM Colour
  element. The bitstream fix itself worked.
- **Variable frame rate.** Mutter sends a frame only when the screen changes,
  so recordings are VFR (≥1 fps from `keepalive-time`). YouTube lists fixed HDR
  frame rates. A VFR source also breaks the encoder's rate control and its VUI
  timing.
- **Not fixed: HDR10 static metadata.** Recordings carry no mastering display
  or MaxCLL/MaxFALL. Reasons: `qtmux` can't write `mdcv`/`clli`; `webmmux`
  can but scales luminance wrongly (see quirks); ffmpeg's CLI can't add it on a
  stream copy; and Mutter doesn't know the real peak (below).
- Also worth knowing: YouTube lists 720p/1080p/1440p/2160p for HDR, so area
  recordings with odd sizes might still not get HDR. HDR above 60 fps won't
  either. Neither is verified with an upload.

### 2. HDR recordings look greenish on the phone

- Checked whether the **pixels** could be wrong on Intel by reading the
  sources:
  - GStreamer `vapostproc` gives iHD `VAProcColorStandardExplicit`, since
    `bt2100-pq` matches no preset. iHD advertises Explicit for input and
    output (`ddi_media_functions.cpp`).
  - iHD maps RGB+BT.2020+full range to `CSpace_BT2020_RGB`, and P010+BT.2020+
    limited to `CSpace_BT2020`, both with ST2084 gamma.
  - iHD's HDR/tone-mapping stage runs only when HDR metadata is passed, or for
    601/709→2020 (`VPFeatureManager::IsHdrNeeded`). Neither applies.
  - So it's a plain BT.2020 matrix conversion, and **on Intel the pixels should
    be right.**
- What *was* wrong is the signalling phones read. MP4 had no `colr` box, and
  WebM's container matrix (BT.709) disagreed with its bitstream (BT.2020).
  Phones vary in which one they trust. Fixed (see changes).
- **Not reproduced.** I had no phone and no sample file. A matrix mismatch
  shifts hue in saturated colours; it doesn't make neutrals green. If it's
  still green after this fix, ask for:
  - the phone model and the app used to play the file
  - `ffprobe -v error -show_streams -show_entries stream=codec_tag_string,color_range,color_space,color_transfer,color_primaries FILE`
  - `mediainfo FILE`
  - which recording format (MP4 H.265 / AV1, or WebM VP9).

  Also check whether the file was re-shared through an app that transcodes it.

### 3. HDR screenshots don't show as HDR on the phone

- PNG (16-bit, `cICP` 9/16/0/1) and AVIF (10-bit PQ) were written correctly
  (verified). But phone galleries don't display PQ stills as HDR; they show
  them as SDR. Phones (Android 14+, iOS 18+) and Chrome display HDR photos as
  **gain-map JPEGs** (Ultra HDR v1.1: Adobe/Google `hdrgm` XMP + ISO 21496-1
  + MPF).
- Fixed by adding an "Ultra HDR JPEG" HDR format, now the default.

## Changes

| File | Change |
|---|---|
| `lib/recorder.js` | remux adds `-color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv` (container now matches the stream) and `-tag:v hvc1` for HEVC; HDR chain gets `videorate ! capsfilter framerate=…` after `vapostproc` (constant frame rate) |
| `lib/hdr-encode.py` | new `jpeg` mode: builds a luminance gain map from GNOME's SDR shot and the 16-bit PQ capture, encodes both with GStreamer `jpegenc`, writes the Ultra HDR container. png/avif unchanged (just refactored into `read_halves`/`join_rgb16`) |
| `lib/capture.js` | `paintHdr` also returns `white` (SDR white in nits, parsed from the colour state's `ref lum:`, fallback 203); `_encodeHdr` sends the SDR pixbuf as well for jpeg, and uses `EXTENSIONS[format]` (`.jpg`) |
| `extension.js` | passes `white` along in `shot.hdr` |
| `prefs.js`, schema | `hdr-format` gains `jpeg` (default now `jpeg`); texts updated; `gschemas.compiled` rebuilt |
| `README.md` | describes all of the above |

### How the Ultra HDR writer works (`hdr-encode.py jpeg OUT QUALITY WHITE`)

- stdin: the existing HDR halves, then `"<w> <h> <rowstride> <channels>\n"` +
  the SDR pixbuf bytes. GdkPixbuf's last row is unpadded:
  `rowstride*(h-1) + w*channels` bytes.
- The gain map is sampled at one spot per block. The block is 1, 2, 3… pixels,
  chosen so the map stays ≤ 1 MP, and the same spot is used in both pictures:
  - per sample, `ratio = (Y_hdr/white + 1/64) / (Y_sdr + 1/64)`
  - Y_hdr: BT.2020 luminance of the PQ-decoded values
  - Y_sdr: BT.709 luminance of the linearised sRGB values
  - The ratio is quantised to 8 bits on a log2 scale using a bisect over 255
    thresholds, with no per-pixel `log2`.
  - Pure Python: ~1.2 s for 3840×2160, 0.4 s for 1366×768.
- Range: GainMapMin = 0 (never darker than SDR). GainMapMax = HDRCapacityMax =
  log2((peak + 1/64)/(1 + 1/64)), where peak is the brightest sampled HDR
  luminance. This cap stops the pointer, which is only in the SDR shot, from
  skewing the scale. The floor is 0.01 so min ≠ max when nothing is HDR.
- JPEGs: the base goes RGBA → `videoconvert` → Y444 `colorimetry=1:4:0:0`
  (JFIF full-range BT.601, 4:4:4) → `jpegenc`. The gain map is GRAY8 →
  `jpegenc` (one component).
- Container, following libultrahdr's `appendGainMap` layout:
  - primary: SOI, JFIF, XMP (Container directory, GainMap item length), ISO
    APP2 (version only), DQT/SOF/DHT, MPF APP2 (big-endian, 2 entries),
    SOS…EOI
  - gain map: SOI, JFIF, XMP (hdrgm values), ISO APP2 (full metadata,
    single-channel, `use_base_colour_space`), rest
  - rationals use denominator 1e6; offsets are 1/64

## Quirks found along the way (upstream bugs or limits)

- **GStreamer `vapostproc` colour scoring bug** (`gstvafilter.c`,
  `_config_color_properties`): when there's no exact standard and no Explicit,
  it compares GStreamer enum values (matrix BT2020 = 6, primaries BT2020 = 7)
  against ISO codes from `va_vpp.h`. For `bt2100-pq` it then picks **BT.601**
  (score 3) over BT.2020 (score 5). This doesn't affect iHD or current Mesa,
  which both offer Explicit, but would hit a driver without it.
- **GStreamer `matroskamux`/`webmmux` mastering luminance bug**: it divides by
  `luma_scale = 50000`. The unit is 0.0001 cd/m², and the demuxer uses 10000,
  so luminance is written **5× too low**. Don't pass `mastering-display-info`
  caps to it without compensating, and expect upstream to fix it.
- `qtmux`/`mp4mux` writes `colr` from caps but never `mdcv`/`clli`.
- GStreamer caps strings for HDR: `mastering-display-info` is
  `Rx:Ry:Gx:Gy:Bx:By:Wx:Wy:max:min` in 1/50000 and 1/10000 cd/m² units (R
  first, unlike x265's G,B,R). Encoders and parsers do pass these caps through
  (tested with x265enc/vp9enc + parsers).
- **ffmpeg stream copy** takes container colour from the decoder's probe of
  the bitstream. Explicit `-color_*` output options override it with `-c copy`.
  Tested on 6.1; the user likely has 7.x/8.x, so re-check with ffprobe.
- ffmpeg's `mjpeg` encoder silently turns gray input into 3 components. That's
  why `jpegenc` is used for the one-channel gain map.
- `jpegenc` with **RGB** input stores untransformed RGB (component IDs
  'R','G','B', no JFIF); go through Y444 for normal YCbCr JPEGs.
- Mutter's HDR output colour state uses the **PQ default luminance**
  (`max lum` 10000, `ref lum` 203 × the HDR brightness factor), not the
  monitor's EDID peak. So `ref lum` gives SDR white, but there's no real peak
  for MaxCLL.
- `ClutterColorState.to_string()` format (Mutter main):
  `ClutterColorState N (primaries: …, transfer function: PQ, min lum: …, max lum: …, ref lum: …, mastering max lum: …)`.
- Gain-map alignment ambiguity: libultrahdr's encoder averages blocks, its
  decoder maps map pixel k to image pixel k·scale. So region edges can shift by
  up to half a block. Harmless.
- `pipewirehdrsrc` maps Mutter `xRGB_210LE` → `BGR10A2_LE`/`AR30`; that matches
  DRM's XRGB2101010 bit layout (B in the low bits).

## Testing done (in a Linux container, no GNOME Shell, no GPU, no phone)

- Recording metadata:
  - 10-bit HEVC/AV1/VP9 test streams with untagged colour, muxed by
    `mp4mux`/`webmmux` with `colorimetry=bt2100-pq` caps
  - then the **exact argv built by `recorder.js`**, extracted from the file
    with a small node script
  - checked with mediainfo/ffprobe/trace_headers: container and stream both
    BT.2020/PQ/BT.2020nc/limited for all three codecs, and `hvc1` for HEVC
- `videorate` (system memory stand-in): a stream with 70% of frames dropped
  comes out CFR at 60/1 and 60000/1001.
- Ultra HDR, built and checked against **libultrahdr's `ultrahdr_app`**
  (Google's reference decoder):
  - decodes, and the HDR ramp reconstructs to within ~1% of the source
  - SDR areas and thin dark lines are unchanged (no halos)
  - the XMP-only and ISO-only variants decode identically
  - exiftool reads hdrgm, MPF and the Container directory
  - also covered: odd sizes, RGB with padded rowstride, SDR one pixel smaller
    than HDR, and truncated input (clean exit 1, no file)
- png/avif output is unchanged; the JS files parse (`node --check`); the schema
  compiles with `--strict`.

**Not tested:**

- running inside GNOME Shell 50
- the VA-API pipeline with `videorate` on real `VAMemory`
- a real phone
- a real YouTube upload

If HDR recording fails to start after this change, check the journal for
`Screenshot Plus: pipeline hdr-… failed`. If needed, the `videorate` step can
be dropped without affecting the colour fixes.

## Useful commands

```sh
# what a recording says, container vs stream
mediainfo --Inform='Video;%CodecID% | %colour_primaries% (%colour_primaries_Source%) | %transfer_characteristics% (%transfer_characteristics_Source%) | %matrix_coefficients% (%matrix_coefficients_Source%) | %FrameRate_Mode% %FrameRate%' FILE
# bitstream VUI
ffmpeg -loglevel debug -i FILE -map 0:v -c copy -bsf:v trace_headers -frames:v 1 -f null - 2>&1 | grep -E 'colour_primaries|transfer_char|matrix_coeff'
# Ultra HDR metadata
exiftool -G1 -XMP:all -MPF:all SHOT.jpg; exiftool -b -MPImage2 SHOT.jpg | exiftool -XMP-hdrgm:all -
# decode with libultrahdr (github.com/google/libultrahdr, build examples)
ultrahdr_app -m 1 -j SHOT.jpg -o 0 -O 4 -z out.raw   # linear half-float RGBA, 1.0 = SDR white
```

## Round 2: measured in a real GNOME Shell 50.1 session

### Test environment (rebuildable)

There's no GNOME on the host and no GPU, so I used an Ubuntu 26.04 chroot:
GNOME Shell/Mutter 50.1, GStreamer 1.28.2, PipeWire 1.6.2, FFmpeg 8.0.1, Mesa
26 llvmpipe.

- `debootstrap --variant=minbase resolute /srv/g50 …`, then apt `gnome-shell
  pipewire wireplumber gstreamer1.0-{pipewire,tools,plugins-*} ffmpeg python3
  mesa…`.
- Mount `/proc /sys /dev /dev/pts`, plus tmpfs on `/dev/shm` and **`/run`**.
  A leftover `/run/systemd/seats` makes gnome-shell expect logind and crash.
  Start a system bus with `dbus-daemon --system --fork`.
- As user `tester`:
  `dbus-run-session` → `pipewire` + `wireplumber` →
  `MUTTER_DEBUG_FORCE_HDR=1 gnome-shell --headless --virtual-monitor 1920x1080 --wayland --no-x11 --automation-script auto.js`.
- `MUTTER_DEBUG_FORCE_HDR=1` gives the virtual monitor the same BT.2020/PQ
  output colour state a real HDR monitor gets (`meta-color-device.c`).
  Virtual outputs otherwise advertise no colour modes.
- `auto.js` exports `run()`, which sets `global.context.unsafe_mode = true`
  and never returns (the shell exits when it does). Then
  `gdbus call … org.gnome.Shell.Eval` drives everything:
  - draw `St.Widget` colour patches
  - call `stateObj._screenshotStage()` with `hdr-format` png/avif/jpeg
  - import `lib/recorder.js` and run `Recorder`
- Not possible here: dmabuf screen-casts (no GBM) and VA-API, so the
  `hdr-dmabuf` + `vapostproc` + `vah265enc` path the user's Intel machine uses
  can't run.

### Measurements (12 sRGB patches on grey; `hdr-check.py` does the same)

- **PQ PNG:** exact. Neutral (white 198/198/198 nits; ref lum 203), every
  colour within ±3 of 255.
- **Ultra HDR JPEG:** the base is GNOME's SDR copy, and it's exact. The gain
  map is all zero for SDR content (headroom 0.01), as designed. So for SDR
  content the file *is* a correct sRGB JPEG; a green look of SDR content can't
  come from this file.
- **AVIF:** +3…5% green on neutrals. **Cause: FFmpeg 8.0 `swscale`** converts
  neutral rgb48 → yuv444p10 full range as Cb = Cr = 511 (and luma +3);
  FFmpeg 6.1 gives 512. `-sws_flags accurate_rnd` doesn't help. **Fixed:**
  `zscale=m=2020_ncl:r=full`, which matches an exact BT.2020 computation code
  for code; swscale is the fallback when ffmpeg lacks zimg. Re-measured in the
  session: 0.0%.
- **Recording, `hdr-memfd` candidate:** nonsense colours (grey → yellow, white
  → red). **Mutter 50.1 bug:**
  `meta_screen_cast_monitor_stream_src_record_to_buffer` always calls
  `clutter_stage_paint_to_buffer(…, COGL_PIXEL_FORMAT_CAIRO_ARGB32_COMPAT, color_state)`.
  That's 8-bit BGRA, but PQ-encoded with the negotiated colour state, even
  when `xRGB_210LE` was agreed. Raw word for grey 128 = `0xff6d6d6d` (PQ 0.427
  in 8 bits). **Fixed:** the `hdr-memfd` candidate is removed, so HDR needs
  DMA-BUF and otherwise the recording falls back to SDR with correct colours.
  This scramble is red/magenta, not "greenish", so it's probably *not* what
  the user sees.
- **Recording, SDR fallback** (monitor stream in HDR mode, 8-bit BGRx with an
  SDR colour state): correct colours (white 255/255/252).
- The remux tags (`colr` + VUI, `hvc1`) and `videorate` CFR 60 were confirmed
  on a real Mutter PQ stream.

### Still open

- **Green video on Intel.** Everything up to `vapostproc` is verified except
  the iHD RGB→P010 conversion itself, and Mutter's dmabuf blit. iHD gets
  `VAProcColorStandardExplicit` with BT.2020 RGB full → BT.2020 limited and
  ST2084 on both sides, which is a plain CSC (no tone mapping without HDR
  params). A conversion bias like FFmpeg 8's is possible but unproven.
  `/home/user/hdr-check/` has `hdr-test-pattern.png` + `hdr-check.py` for the
  user to measure a real recording.
- **Green photo.** If the user's `hdr-format` is AVIF, the swscale bias above
  explains it, and it's fixed. If it's Ultra HDR JPEG, the file is exact for
  SDR content. Then it's the phone's HDR rendering, or a comparison against
  the HDR monitor (many monitors render a different white in HDR mode). Ask
  whether a plain SDR screenshot looks equally green on the phone.
- **YouTube.** HDR is shown only as "1080p HDR" in the quality menu, only on
  HDR-capable phones/TVs ("non-HDR devices … see SDR"), and the HDR transcode
  finishes later than the SDR one. Find out where and when the user checked.
  Also confirm with `hdr-check.py` (or `journalctl --user -b | grep 'Screenshot Plus'`)
  that the recording was really `hdr-dmabuf`, 10-bit, PQ.

## Round 3 (2026-10-18): YouTube link, one image for desktop + phone

### YouTube: the upload *is* HDR

`yt-dlp --extractor-args "youtube:player_client=android_vr;formats=missing_pot" -F <url>`
lists formats even where YouTube's bot check blocks downloads from this
container. For https://www.youtube.com/watch?v=zjOAA1iyXas:

- AV1 10-bit **HDR** renditions 694–701 (144p60 HDR … "1440p60 HDR" at
  2880×1800), plus normal SDR avc1/vp9 ones. The source is 16:10 (2880×1800).
- **No VP9 Profile 2 HDR** renditions. So only clients that decode AV1 *and*
  have an HDR display get HDR: iPhone 15 Pro and later, Pixel 6 and later,
  recent Galaxy, HDR TVs. Everything else (desktop Linux browsers, phones
  without AV1 decode) gets SDR. YouTube decides which codecs it transcodes.
  To check on a device: Stats for nerds should show `av01… (70x)` and
  `bt2020/smpte2084`.
- The thumbnails (YouTube's SDR tone map of the upload) show an HDR test video
  with "1000 nits" white circles measuring **(240, 254, 241)**. That is green
  in the source pixels, since a neutral white stays neutral through any sane
  tone map.

### Green tint: what was ruled out (GNOME 50.1 session, llvmpipe)

- A video client's YUV buffer composited by Mutter, measured through the
  extension's HDR screenshot:
  - P010 with BT.2100-PQ + colour-representation (GStreamer `waylandsink`),
    P010/NV12 without any colour info (own pywayland client
    `test/p010.py`), and NV12 BT.709: **all neutral** (0.0%).
  - `meta-multi-texture-format.c` does use 8-bit constants (128/255, 16/255)
    for P010, which looked like a bias of about 4%, but the measured output
    is exact. The constants aren't what decides it.
- Mutter's HDR output colour state is plain BT.2020/PQ; no ICC or EDID white
  point in HDR mode (`meta-color-device.c`).
- So the tint is GPU- or app-specific and not reproducible here:
  - Mutter importing the player's P010 **dmabuf** on Intel (EGL/iris), only
    for the GL composite that screenshots and screen-casts use. A fullscreen
    video on the monitor is likely scanned out directly with hardware CSC,
    which would explain why the monitor looks right.
  - The player itself.
  - The iHD encode, for the video.
- Next data needed:
  - which player and app showed the HDR test
  - a plain GNOME screenshot (extension's HDR switch off) of a paused bright
    white frame; if *that* is green, it's the composite
  - the original recording file

### One image for GNOME and phones: AVIF with a gain map (now the default)

glycin 2.1.5 (GNOME 50, loaded with GJS + `GlyGtk4.frame_get_texture`, the
same path Loupe uses):

| file | colour state GTK gets |
|---|---|
| AVIF with PQ base + gain map (libavif's and ours) | BT.2020 / PQ (HDR) |
| PQ PNG, plain PQ AVIF | BT.2020 / PQ (HDR) |
| Ultra HDR JPEG | sRGB (SDR; glycin ignores gain maps) |

- So the cross-compatible file is an **AVIF with an HDR base + ISO 21496-1
  `tmap` gain map**:
  - glycin shows the base in HDR
  - gain-map readers (iOS 18+/macOS 15+, Chrome/Edge; libavif 1.2+) map it to
    the screen
  - readers with PQ but no gain maps show the HDR base
  - Android's AVIF gain-map support is **unconfirmed** (JPEG yes, PNG in 16).
- `hdr-encode.py avif` writes it without new dependencies:
  - The base is ffmpeg/libaom 4:4:4 10-bit PQ via `zscale` (`-row-mt 1`).
  - The gain map is a monochrome AV1 (`-pix_fmt gray`).
  - Both come from ffmpeg's one-image AVIFs (parsed for av1C/pixi/ispe/data)
    and are re-assembled in libavif's layout: `pitm`=base, item 2 `tmap`
    (`dimg` → base, gain map), item 3 hidden gain map, `altr` group [2, 1],
    ftyp brands avif/mif1/miaf/MA1A/tmap.
- Validated with libavif 1.3: `avifdec --info` ("Base Image is HDR"),
  `printmetadata`, `tonemap` at headroom 0/1/4. In the HDR scene test:
  - SDR rendition = GNOME's SDR copy (window 226 = 226, background 34 vs 33,
    mean diff 2.3 codes)
  - headroom 4 = base (981 nits)
- libavif's `tonemap` shifts saturated colours (red 255,0,0 → 255,46,0) on
  libavif's *own* files too: a quirk of the tool, not the file.
- **Sign convention (bug found and fixed):** ISO 21496-1 gain maps always
  hold log2(HDR / SDR). For an HDR base, readers apply them with *negative*
  weight (libavif `avifGetGainMapWeight`; libavif's encoder flips the sign).
  Both writers now share `gain_map()`, which stores HDR/SDR.
- **Range bug, found and fixed in both formats:** GNOME's SDR copy *tone-maps*
  a 1000-nit white to 226, not 255, and makes dark areas slightly lighter than
  the HDR capture. The old fixed caps ("brightest pixel → SDR white", "never
  darker") were wrong. The Ultra HDR JPEG rendered that window at ~745 instead
  of 981 nits; it's 984 now. The range now comes from the measured ratios,
  with pointer guards: near-black SDR samples don't set the top, and darkening
  stops at 2×.
- Speed (4 cores): 4K AVIF ~11 s (libaom; was already the cost of the old
  AVIF), 4K Ultra HDR JPEG ~1.4 s.
- ffmpeg/ffprobe ignore `colr` in multi-item AVIFs, libavif's own included.
  So ffprobe shows the gain-map AVIF as untagged; `hdr-check.py` assumes the
  extension's tags for AVIFs.

### Test-session helpers (host)

- `g50-start`: mounts the chroot and starts gnome-shell.
- `geval JS`: Eval in the shell.
- `gshot avif|jpeg|png`: HDR screenshot through the extension.

In the chroot `/home/tester/test/`:

- `show.sh FMT COLORIMETRY RGB`: fullscreen YUV via waylandsink
- `hdrwin.sh`: 1000-nit P010 PQ window
- `p010.py`: YUV surface without colour info
- `/tmp/gm/gly.js`: what glycin hands GTK

## Round 4 (2026-10-18): user test results

User reported:
- YouTube AV1 HDR plays as HDR on the phone.
- The gain-map AVIF is HDR on the PC and in the phone's native gallery, **not
  in Google Photos**.
- The YouTube HDR tint shows only in the YouTube mobile app.

- **Google Photos:** reads gain maps in JPEG only (Ultra HDR); no AVIF
  gain-map or PQ AVIF HDR found in any source. glycin reads PQ only, no gain
  maps. So no single file is HDR in both GNOME's viewer and Google Photos
  today. AVIF covers PC + native gallery + iOS/Chrome; Ultra HDR JPEG covers
  Google Photos + Android galleries.
- **Tint: it is in the recording.**
  - The user's screenshot is of their upload "hdr test 5" (zjOAA1iyXas, 16:10
    pillarboxed). The content is a desktop-browser recording of BRollTech
    "Blooming Test HDR TV" (TlmD_-Hwzp8), found by parsing ytInitialData
    from a youtube.com/results fetch.
  - YouTube's own thumbnail of the **original** shows neutral circles (228,
    228, 228); of the **upload**, mint (241, 253, 242). The app shows (195,
    234, 215). Same YouTube pipeline, so the upload's pixels are green.
  - In round 2 the user said the photo of this scene was green too, and the
    screenshot path never touches iHD. So the screen content itself (the
    browser's HDR video rendering, composited by Mutter) is the prime suspect.
    The monitor may hide it by clipping 1000-nit highlights at its peak, where
    YouTube's tone-mapping reveals it.
- **Decisive test (asked of the user):** pause on the circles; take an HDR
  screenshot (AVIF) and a 3 s recording of the same paused frame; say which
  browser. Measure the circle's R/G/B nits in both:
  - both green → browser/compositor
  - recording only → iHD encode
  - neither → YouTube-side
- User add-on: "tint also persists on the laptop", so it isn't specific to the
  YouTube app; consistent with the upload's pixels being green. Still open:
  whether the live screen shows it (browser/compositor) or only the recording
  (encode). The screenshot + recording test above settles it.

## Round 5 (2026-10-18): the user's paused-frame test, and the tint's cause

User sent a recording and an AVIF screenshot of the same paused Firefox frame
(BRollTech circles, 2880x1800, 120 fps AV1), and reported that their own AVIF
screenshot shows no HDR on the phone at all (native gallery or Google Photos),
although the 1920x1080 sample had worked in the native gallery.

### Tint: Intel's render-path CSC rounds the matrix to 1/128

- Screenshot circles: 460/460/460 nits, neutral. Recording: Y 658, Cb = Cr =
  507 where 649/512/512 is right. Black is exact. So the green comes from the
  recording, at the RGB -> P010 step.
- A pixel fit of recording YCbCr against screenshot RGB (39 flat colours)
  gives row sums Y 888.5, Cb -7.1, Cr -7.1 (10-bit codes per unit). The chroma
  rows of a correct matrix sum to 0.
- Cause (intel/media-driver, VP):
  - VEBOX and SFC can't read R10G10B10A2 (`VP_FF_VEBOX_FORMAT(..., 0, ...)` on
    every gen through Xe3), so the CSC runs in the render FC kernel.
  - `KernelDll_UpdateCscCoefficients` (`hal_kerneldll_next.c`) stores the
    coefficients as 9.7 fixed point (`ROUND_FLOAT(m, 128)`).
  - BT.2020 RGB -> limited YUV rounds to Y [29 75 7], Cb [-16 -41 56], Cr
    [56 -52 -5] (/128): row sums 111, -1, -1.
  - Modelled, that gives a grey at 0.6676 of Cb = Cr = 506.7, and the orange
    stats bar (563, 512, 408) of Cb/Cr 456.3/534.3. The recording has 507 and
    456.1/534.0.
- Things that don't apply:
  - vapostproc adds no filters by default; it only sends values that differ
    from the driver's defaults.
  - The HDR 3DLUT path is off (no `pHDRParams`).
  - Full-range output would round to zero-sum chroma rows (Y +0.8%), but a
    full-range stream risks YouTube/player handling.
  - A second YUV -> YUV pass hits `KernelDll_CalcYuvToYuvMatrix`, which scales
    the pre-scaled `g_cCSC_BT2020_RGB_LimitedYUV` table by 219/255 again.
- **Attempted fix, withdrawn in round 6:**
  - `vapostproc contrast=0.99835 saturation=0.99735`. The FC kernel folds
    procamp into the matrix (PA x ICSC) before rounding, so the rounded matrix
    becomes Y [29 74 7], Cb [-16 -40 56], Cr [56 -51 -5]: exact for greys,
    Y +0.06%.
  - The windows are contrast 0.99712..0.99956 and contrast x saturation
    0.99522..0.99617 (scratchpad `procamp.py`).
  - Procamp goes to the render path because VEBOX can't take the format.
    BT2020_RGB isn't in SetupCSC's "no procamp for RGB" list, and the source is
    SURF_IN_PRIMARY (main video).
  - Where the driver doesn't round, these values are a 0.2-0.4% change.
  - Candidate `hdr-dmabuf-plain` is the same pipeline without the properties
    (Mesa has no colour balance, and gst-launch fails on an unknown property).
  - Not verified on Intel hardware: `hdr-check/vpp-tint-test.py` sends known
    colours through vapostproc with and without the setting and prints YCbCr.
    Its parsing was checked here with `VPP_TEST_ELEMENT=videoconvert`.

### Phone HDR for the user's own screenshot: test files sent

- The user's AVIF has the same layout as the sample that worked: same items,
  brands, profile 1 4:4:4. Differences:
  - 2880x1800, AV1 level 5.0 (the sample is 4.0)
  - gain map at 1/3 size (960x600) instead of 1/2
  - base headroom 1.24 (sample 2.28)
- Android 15+ decodes AVIF through Skia `SkCrabbyAvifCodec` -> CrabbyAvif ->
  MediaCodec. Its gain-map checks (non-zero denominators, gamma) pass for both
  files, so the reason isn't visible from source.
- `/home/user/phone-tests/` (+ zip) is made from the user's shot, rebuilt via
  scratchpad `variants/` (base16.png, sdr.png, white 194 nits, measured):
  - a: as now
  - b: 4:2:0 Main profile, MA1B
  - c: 1920x1200, 1/2 gain map
  - d: Ultra HDR JPEG
  - e: SDR base + gain map up (Android's direction)
- All decode with libavif and libultrahdr at 460 nits HDR / 218 SDR (JPEG 482
  at libultrahdr's 203-nit white). glycin: a, b, c are PQ; d, e are sRGB.
- Waiting on which ones show HDR on the phone. If b works, switch the base to
  4:2:0. If only c works, the gallery drops gain maps for big images. If only
  e works, the phone handles SDR-base gain maps only, and one file can't cover
  both Loupe and the phone. Google Photos needs d whatever the result.

### Other

- The recording was 120 fps. YouTube serves at most 60 fps (HDR included),
  so it converts the frame rate.

## Round 6 (2026-10-18): tint test on the laptop, phone results

### Procamp workaround: no effect, because iHD drops procamp for RGB input

- `vpp-tint-test.py` on the user's laptop gave identical output with and
  without the colour balance.
- The "before" output matches the 1/128 model exactly. White is 951/504/504:
  Y = 64 + 1023 x 111/128, and Cb = Cr = 512 - 1023/128.
- Cause: `SwFilterProcampHandler::IsFeatureEnabled` contains
  `if (!IS_RGB_FORMAT(...)) return true; else "Procamp: input format is RGB
  format, driver disable Procamp"`.
- Other routes checked:
  - Two VA passes (RGB -> full-range YUV -> limited YUV): the YUV -> YUV
    matrix from `KernelDll_CalcYuvToYuvMatrix` (used by SFC and VEBOX, both
    via `KernelDll_GetCSCMatrix`) applies 219/255 to the already-scaled
    `g_cCSC_BT2020_RGB_LimitedYUV`. Grey 255 -> Y 204, so it comes out dark.
  - GL: `glcolorconvert` can't output P010 ("Don't know how to convert from
    BGR10A2_LE to P010_10LE", GStreamer 1.28). It can output Y410 or Y210,
    but that means reading back and re-uploading ~20 MB per frame (2880x1800);
    too heavy at 120 fps.
- **Fix (recorder.js):**
  - On iHD (vapostproc's long name contains "iHD"; `gst-inspect-1.0
    vapostproc`, run by prewarm) the first HDR candidate is
    `hdr-dmabuf-full`: P010 at `colorimetry=1:6:14:7` (full range, BT.2020
    matrix, PQ).
  - Rounded rows: Y [34 87 8], Cb [-18 -46 64], Cr [64 -59 -5]. Colour sums
    are 0; chroma error <= 1.2 codes for any colour, Y +0.8%, Y clips at 1023
    only above ~9000 nits.
  - The remux writes full range: av1 `color_range=pc`, hevc
    `video_full_range_flag=1`, vp9 `color_range=pc`, container
    `-color_range pc`. Checked with trace_headers and the MP4 colr box.
  - Other drivers: `hdr-dmabuf` as before (limited).
- Risk: full-range HDR is unusual. YouTube and players should honour the flag
  (Android even names full-range PQ `HAL_DATASPACE_BT2020_PQ`), but it needs
  an upload test.
- `vpp-tint-test.py` now compares limited and full-range output (checked
  against videoconvert in the chroot). Expected on iHD full range: grey 67%
  -> 687/512/512.

### Phone results (round 1 files)

- Google Photos: d (Ultra HDR JPEG) and e (SDR-base AVIF). So it reads gain
  maps in AVIF too, but only with an SDR base.
- Native gallery: c (1920x1200 HDR base, 1/2 map) and d (2880x1800 JPEG,
  1/3 map). Not a (2880x1800 HDR base, 1/3 map) or e (2880x1800 SDR base,
  1/3 map).
- glycin 2.2.2 (latest, 2026-10-06) NEWS has nothing on gain maps.
  - Image Viewer: HDR only from an HDR (PQ) base.
  - Google Photos: HDR only from an SDR base.
  - So no one file is HDR in both. A "save both" option or a choice of format
    is the only way.
- Round 2 (`/home/user/phone-tests-2`): f = a with a 1/2 map, g = a with a
  1/4 map, h = e with a 1/2 map. These separate the gain-map scale from the
  picture size for AVIF in the native gallery.

## Round 7 (2026-10-18): "still green", own conversion, floating stop button

### The user's new recording wasn't made by the full-range pipeline

- `vpp-tint-test.py` on the laptop: full range came out neutral
  (687/512/512 etc.), exactly as modelled.
- Their new recording (`chrome_olOErrDBWv.mp4`, 2838x1530 area, 120 fps
  AV1) is tagged limited (`color_range=tv`, AV1 `color_range=0`), and its
  greys are tinted as before (Cb = Cr = 505 at Y 728).
- So the full-range pipeline didn't run. Either GNOME Shell still had the old
  JS (Wayland reloads extension code only at login), or `hdr-dmabuf-full`
  failed and the recorder silently fell back to the tinted `hdr-dmabuf`. The
  VA encoders don't look at colorimetry, so the first is likelier.
- Fix: never fall back to a conversion that wasn't measured right.

### Self-tested conversion (`lib/vpp-check.py`, recorder.js `measureHdrConversion`)

- Runs once per session from prewarm.
- Test frame: four 16x16 BGR10A2_LE patches (grey 67%, white, grey 25%,
  orange) through `rawvideoparse` -> each variant -> P010 system memory.
- Pass: |Cb|, |Cr| within 2 codes, and Y within 2 + 1.5%.
- Order:
  - `limited`
  - `twopass`: RGB -> limited RGB (2:1:14:7) -> limited YUV
  - `full`
  - otherwise `cpu`
- Recorder candidates: `hdr-dmabuf-<measured>`, then `hdr-dmabuf-cpu`, then
  SDR. The choice is logged.
- twopass on iHD, from the source:
  - Pass 1: `g_cCSC_BT2020RGB_BT2020stRGB` (diag 0.856305 -> 110/128, offset
    64).
  - Pass 2: stRGB -> BT2020 rows Y [34 87 8], Cb [-18 -47 65], Cr [65 -60 -5]
    (colour rows sum to 0). Offsets cancel (Y_o - Y_e*R_o/R_e = 0).
  - Predicted: grey 67% 655/512/512, white 950/512/512, so Y is +1.1% and
    neutral. Not yet measured on hardware; the self-test decides.
- On the user's laptop (measured): limited fails, full passes. twopass is
  expected to pass and would be chosen (standard limited range).
- cpu chain: vapostproc (DMA-BUF -> BGR10A2_LE system memory: crop/scale,
  no CSC) ! videoconvert n-threads ! P010 bt2100-pq ! videorate ! VA encoder.
  videoconvert takes ~13.5 ms per 2880x1800 frame on 4 threads here.
- `limited`/`twopass` must agree with the remux tags. Only `full` sets
  `_hdrFullRange`.
- Tested in the GNOME 50 session (no VA): the self-test says `cpu`;
  `hdr-dmabuf-cpu` fails ("no element vapostproc"); SDR fallback records.
  It never tried a tinted pipeline.

### Floating stop button (`lib/stop-button.js`, extension.js)

- Mutter 50.1 monitor streams take frames at META_STAGE_WATCH_AFTER_ACTOR_PAINT
  or AFTER_PAINT, inside MetaStage's paint_view class handler. They either
  `cogl_framebuffer_blit` the view framebuffer, or use a separate
  `clutter_stage_paint_to_framebuffer` (different colour state, e.g. HDR).
  Area streams use `clutter_stage_paint_to_buffer`.
- So: `global.stage.connect_after('paint-view')` draws the button with Cogl
  into `view.get_framebuffer()` after capture and before swap.
  - Projection and modelview are set to identity. Clutter's viewport spans
    the whole stage, so stage coordinates map to NDC directly.
  - A fragment snippet draws the disc, ring and rounded square,
    anti-aliased and premultiplied.
  - `stage.color_state.add_pipeline_transform(view.color_state, pipeline, 0)`
    handles colour. In forced HDR the view colour state is sRGB gamma 2.2,
    ref 80, mastering 3940, so UI colours pass through.
- Blit path gotcha: the blit copies the whole framebuffer, and regions left
  out of a frame's redraw clip keep older pixels (with the button). So
  `after-paint` queues a redraw of the button's actor every frame. Its square
  is then always repainted by the stage before the capture.
- Cogl blends only pipelines it thinks are translucent. With an opaque
  colour and a null texture it wrote black corners, so the pipeline colour
  alpha is set to 128 (the snippet ignores it).
- Input: transparent reactive St.Button (no style, paints nothing) in top
  chrome. `global.compositor.disable_unredirect()` while shown, since direct
  scanout skips the stage paint.
- Placement: just outside the area (below, right or above its bottom-right
  corner) when the monitor has room, else inside (whole screen).
- Verified in the headless session:
  - Copying the view framebuffer (`fb.blit` into an offscreen ->
    `Shell.Screenshot.composite_to_stream`) after drawing shows the button.
  - Recordings (monitor stream 3 s, and an e2e via ScreenshotUI) contain none
    of its pixels.
  - A virtual-pointer click at its centre fires `clicked`; hover works.
  - Lifecycle: created after `recorder.start()`, destroyed on stop, on an
    error end, and in disable().
- Gotchas:
  - GJS `fb.read_pixels` with a Uint8Array crashed gnome-shell; use the blit
    route.
  - Cogl 18 has no `identity_matrix` or `set_color4f`; use
    `set_modelview_matrix(identity)` and `set_color(new Cogl.Color({...}))`.

### Other

- `this._file.replace_contents(new Uint8Array(0))` logged
  "contents != NULL" criticals. Now `replace(...).close()`.
- `metadata.json` version-name is `1.0-hdr7`, so the Extensions app shows
  which build is loaded.
- Test-env quirks:
  - Installing gstreamer1.0-gl in the chroot made `sw-dmabuf` hang (EGL fails
    on llvmpipe), after which PipeWire wedged and `sw-memfd` also timed out.
    Removed it again.
  - Restart pipewire/wireplumber with gnome-shell between test runs.

## Round 8 (2026-10-18): confirmed on the laptop

- `vpp-check.py -v` on the user's iHD laptop:
  - `limited`: wrong, (655,507,507) (951,504,504) (286,510,510) (514,456,533)
  - `twopass`: OK, (655,512,512) (950,512,512) (286,512,512) (514,461,536),
    exactly the prediction in round 7.
- The journal shows a 12:42 recording with plain `hdr-dmabuf`, the
  pre-round-6 code that was still loaded before re-login. After re-login,
  `hdr-dmabuf-twopass` was used. The user reports the colours are now
  completely correct.
- Cost of twopass: GPU only (both passes in the iHD render/FC kernel; the CPU
  only runs gst-launch).
  - Extra GPU memory traffic is one 10-bit RGB write plus read per converted
    frame: 2880x1800x4 B x 2 = ~41 MB. That is ~5 GB/s at 120 fps of real
    screen changes, ~2.5 GB/s at 60.
  - videorate duplicates after the conversion, so a static screen costs
    almost nothing extra.

## Round 9 (2026-10-18): phone results for the gain-map size

- Round 2 files (full size 2880x1800, all from the user's shot):
  - native gallery: f (HDR base, 1/2 map) and h (SDR base, 1/2 map)
  - Google Photos: h only
  - GNOME: f, g
- With round 1:
  - **Native gallery**: AVIF gain maps work only at 1/2 scale (a, e at 1/3
    and g at 1/4 failed; c, f, h at 1/2 worked), in either direction. A JPEG
    at 1/3 (d) worked.
  - **Google Photos**: SDR base only (d, e, h), any scale.
  - **GNOME/glycin**: HDR (PQ) base only.
- Change: `hdr-encode.py` `GAIN_MAP_SCALE = 2` for every picture (was "1/2,
  1/3... to stay under 1 MP"). The output for the user's shot now has the same
  layout as f.
  - Time at 2880x1800 here: AVIF ~2.9 s, JPEG ~1.5 s (map 1440x900).
  - Scale 1 (small pictures) is untested on the phone, so 2 is used always.
- Format guidance:
  - AVIF (default, HDR base, 1/2 map): GNOME + native gallery
    (+ iOS/macOS/Chrome).
  - Ultra HDR JPEG: native gallery + Google Photos, SDR in GNOME.
  - No single file covers GNOME and Google Photos until glycin reads gain
    maps (not in 2.2.2).
