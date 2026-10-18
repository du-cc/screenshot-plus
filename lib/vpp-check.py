#!/usr/bin/python3
"""Finds a GPU conversion of 10-bit PQ RGB to P010 that keeps colours right.

Screenshot Plus runs this once per session (lib/recorder.js) before its first
HDR recording. It sends four known colours through vapostproc the ways the
HDR pipeline can do it and prints the first that comes out right:

  limited  RGB -> limited-range YUV in one pass (the normal way)
  twopass  RGB -> limited-range RGB -> limited-range YUV
  full     RGB -> full-range YUV
  cpu      none of them; convert on the CPU instead

Intel's iHD driver does the RGB -> YUV step in a shader with its matrix
rounded to 1/128ths. For BT.2020 to limited-range YUV both colour rows then
sum to -1/128, so greys turn green; from limited-range RGB, or to full-range
YUV, the rounded rows sum to 0.

Usage: vpp-check.py [-v]   (-v: print the measurements to stderr)
"""
import os
import subprocess
import sys
import tempfile

ELEMENT = os.environ.get('VPP_TEST_ELEMENT', 'vapostproc')
# 8-bit sRGB-style values, used as 10-bit PQ codes (x 1023 / 255).
COLOURS = [0xaaaaaa, 0xffffff, 0x404040, 0x8c8066]
PATCH = 16  # pixels per side; the frame is the patches side by side
KR, KB = 0.2627, 0.0593

VARIANTS = {
    'limited': ('bt2100-pq', f'{ELEMENT} ! video/x-raw,format=P010_10LE,colorimetry=bt2100-pq'),
    'twopass': ('bt2100-pq', f'{ELEMENT} ! video/x-raw(memory:VAMemory),format=BGR10A2_LE,colorimetry=2:1:14:7 ! '
                             f'{ELEMENT} ! video/x-raw,format=P010_10LE,colorimetry=bt2100-pq'),
    'full': ('1:6:14:7', f'{ELEMENT} ! video/x-raw,format=P010_10LE,colorimetry=1:6:14:7'),
}


def frame():
    """The patches as one BGR10A2_LE row of PATCH x PATCH squares."""
    width = PATCH * len(COLOURS)
    row = bytearray()
    for rgb in COLOURS:
        r, g, b = ((rgb >> s & 0xff) * 1023 // 255 for s in (16, 8, 0))
        row += (3 << 30 | r << 20 | g << 10 | b).to_bytes(4, 'little') * PATCH
    return width, bytes(row) * PATCH


def expected(rgb, full):
    r, g, b = ((rgb >> s & 0xff) / 255 for s in (16, 8, 0))
    y = KR * r + (1 - KR - KB) * g + KB * b
    yo, ys, cs = (0, 1023, 1023) if full else (64, 876, 896)
    return yo + ys * y, 512 + cs * (b - y) / (2 - 2 * KB), 512 + cs * (r - y) / (2 - 2 * KR)


def convert(folder, chain):
    width, data = frame()
    src = os.path.join(folder, 'in.raw')
    out = os.path.join(folder, 'out.p010')
    with open(src, 'wb') as f:
        f.write(data)
    if os.path.exists(out):
        os.remove(out)
    description = (f'filesrc location={src} ! rawvideoparse format=bgr10a2-le width={width} height={PATCH} '
                   f'framerate=1/1 colorimetry=1:1:14:7 ! {chain} ! filesink location={out}')
    run = subprocess.run(['gst-launch-1.0', '-q', *description.split()], capture_output=True, text=True,
                         timeout=30)
    if run.returncode or not os.path.exists(out):
        raise RuntimeError((run.stderr or run.stdout).strip().splitlines()[-1:] or ['no output'])
    with open(out, 'rb') as f:
        p010 = f.read()
    sample = lambda offset: int.from_bytes(p010[offset:offset + 2], 'little') >> 6
    values = []
    for i in range(len(COLOURS)):
        x, y = i * PATCH + PATCH // 2, PATCH // 2
        uv = width * PATCH * 2 + ((y // 2) * width + (x // 2) * 2) * 2
        values.append((sample((y * width + x) * 2), sample(uv), sample(uv + 2)))
    return values


def good(values, full):
    for rgb, got in zip(COLOURS, values):
        want = expected(rgb, full)
        if abs(got[1] - want[1]) > 2 or abs(got[2] - want[2]) > 2 or abs(got[0] - want[0]) > 2 + want[0] * 0.015:
            return False
    return True


def main():
    verbose = '-v' in sys.argv
    with tempfile.TemporaryDirectory(prefix='screenshot-plus-vpp-') as folder:
        for name, (colorimetry, chain) in VARIANTS.items():
            try:
                values = convert(folder, chain)
            except (RuntimeError, subprocess.TimeoutExpired) as e:
                if verbose:
                    print(f'{name}: failed: {e}', file=sys.stderr)
                continue
            ok = good(values, colorimetry != 'bt2100-pq')
            if verbose:
                print(f'{name}: {"OK" if ok else "wrong"} {values}', file=sys.stderr)
            if ok:
                print(name)
                return
    print('cpu')


main()
