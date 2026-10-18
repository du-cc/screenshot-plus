# Screenshot Plus

An extension for GNOME screenshot and screen record.

> [!NOTE]
>
> This app is **completely** generated from AI and is **only** intended for me. Tested on Fedora, Gnome, Wayland only. I won't add support for **any file managers**, **any window manager**, **any display server**.

Read all technical aspects here: [DOCS.md](./DOCS.md)
<br>
Read all Claude findings here: [readme-claude.md](./readme-claude.md)

## Functions

### Files

- Screenshot / Recording folders
- Subfolders and file names using templates
- Tidy up for existing loose files (tested on GNOME only)

### Screenshots

- Formats: PNG (lossless), JPEG, WebP, AVIF
- Quality (for JPEG, WebP, AVIF, HDR JPEG/AVIF)
- Size / Resolution
- After capture behaviours: Copy to clipboard, Show notification, Play sound

### Recording

- Formats: MP4(H264, H265, AV1), WebM(VP9)
- Encoders: GPU(VA-API), CPU, Automatic(CPU / GPU)
- Frame rate
- Resolutions: Native, 480-2160p
- Bitrate
- Record sounds: System, Mic, Both, None

### HDR support

- Screenshot: Ultra HDR(Google Photos), PNG 16-bit PQ, AVIF with gain map
- Recording: BT.2020, PQ (except H264)

## Screenshots

Files Tab

<img src="docs/files.png" width="300" alt="Files Tab">

Screenshots Tab

<img src="docs/screenshots.png" width="300" alt="Screenshots Tab">

Recording Tab

<img src="docs/recording.png" width="300" alt="Recording Tab">

1000 nits test [Youtube](https://www.youtube.com/watch?v=TlmD_-Hwzp8)

Image (Ultra HDR, Chromium based browsers only)
<img src="docs/1000nits.jpg" width="650" alt="1000 nits dots">

[![Video](docs/1000nits.jpg)](docs/1000nits.mp4)



## Installation
Download [this repo](https://github.com/du-cc/screenshot-plus/archive/refs/heads/main.zip) as zip and run:
```bash
gnome-extensions install screenshot-plus-main.zip [--force]
```

## Development
### AI

Everything. I only prompt and test bugs.


## Todo
- Add HDR support for window capture mode
- Blur glitch in Ultra HDR