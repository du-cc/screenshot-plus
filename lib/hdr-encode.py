#!/usr/bin/python3 -I
"""Writes an HDR screenshot (BT.2020 primaries, PQ transfer).

GNOME Shell can only hand JavaScript 8-bit images, so the extension renders the
16-bit PQ capture as two 8-bit RGBA images: the high bytes and the low bytes.
This joins them back into 16 bits and writes the file, outside the shell's
main loop.

PNG holds the PQ pixels only, which HDR-aware desktop viewers (GNOME's glycin)
show as HDR and phones don't. Phones and browsers show HDR photos through gain
maps (ISO 21496-1): a picture plus a small map of how much brighter or darker
each part gets for the screen's headroom. Both other modes use GNOME's own SDR
screenshot as the SDR rendition:
- avif: the PQ picture as the base, so glycin shows it in HDR, plus a gain map
  down to the SDR picture (tmap item) for gain-map viewers (iOS 18+, Chrome).
- jpeg: Ultra HDR, the SDR picture as the base plus a gain map up to HDR, for
  phones that read gain maps in JPEG only (Android 14+); glycin shows it SDR.

stdin:  "<width> <height>\n" + high RGBA bytes + low RGBA bytes
        avif/jpeg, then: "<width> <height> <rowstride> <channels>\n" + SDR sRGB pixels
usage:  hdr-encode.py png OUT.png
        hdr-encode.py avif OUT.avif QUALITY SDR_WHITE_NITS   (needs ffmpeg)
        hdr-encode.py jpeg OUT.jpg QUALITY SDR_WHITE_NITS   (needs gst-launch-1.0)
"""
import bisect
import functools
import math
import operator
import os
import struct
import subprocess
import sys
import tempfile
import zlib


def read_halves(stream):
    width, height = map(int, stream.readline().split())
    n = width * height
    hi = stream.read(n * 4)
    lo = stream.read(n * 4)
    if len(hi) != n * 4 or len(lo) != n * 4:
        sys.exit('short input')
    return width, height, hi, lo


def join_rgb16(width, height, hi, lo):
    # Big-endian 16-bit RGB: for each channel, high byte then low byte.
    rgb = bytearray(width * height * 6)
    for c in range(3):
        rgb[c * 2::6] = hi[c::4]
        rgb[c * 2 + 1::6] = lo[c::4]
    return rgb


def chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data +
            struct.pack('>I', zlib.crc32(kind + data)))


def write_png(path, width, height, rgb):
    stride = width * 6
    raw = bytearray()
    for y in range(height):
        raw += b'\0'  # filter: none
        raw += rgb[y * stride:(y + 1) * stride]
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 16, 2, 0, 0, 0)))
        # cICP: BT.2020 primaries (9), PQ transfer (16), RGB (0), full range (1)
        f.write(chunk(b'cICP', bytes([9, 16, 0, 1])))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 6)))
        f.write(chunk(b'IEND', b''))


# --- Gain maps ---------------------------------------------------------------

# Gain maps are half the picture's width and height. An Android phone's own
# gallery showed AVIF gain maps at 1/2 size in HDR, and at 1/3 or 1/4 not.
GAIN_MAP_SCALE = 2
OFFSET = 1 / 64  # base and alternate offsets, as in libultrahdr and libavif
REFERENCE_WHITE = 203  # nits; gain-map maths reads PQ with 1.0 = 203 (BT.2408)
XMP_NS = b'http://ns.adobe.com/xap/1.0/\0'
ISO_NS = b'urn:iso:std:iso:ts:21496:-1\0'


def read_sdr(stream):
    width, height, stride, channels = map(int, stream.readline().split())
    size = stride * (height - 1) + width * channels  # GdkPixbuf's last row is unpadded
    pixels = stream.read(size)
    if len(pixels) != size:
        sys.exit('short input')
    return width, height, stride, channels, pixels


def pq_to_nits(code):
    m1, m2 = 2610 / 16384, 2523 / 4096 * 128
    c1, c2, c3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
    p = (code / 65535) ** (1 / m2)
    return 10000 * (max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1)


def srgb_to_linear(value):
    v = value / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def row_getter(offsets):
    get = operator.itemgetter(*offsets)
    return get if len(offsets) > 1 else lambda row: (get(row),)


def sample_luminance(hdr, sdr, white):
    """Luminance of the HDR and SDR pictures, 1.0 being SDR white (white nits
    in the HDR one). Sampled every GAIN_MAP_SCALE pixels, at the same spot in both.

    Returns (width, height, hdr luminances, sdr luminances).
    """
    hw, hh, hi, lo = hdr
    sw, sh, stride, channels, pixels = sdr
    scale = GAIN_MAP_SCALE
    xs = range(scale // 2, sw, scale)
    ys = range(scale // 2, sh, scale)

    # Linear luminance per 8/16-bit code and channel.
    nits = [pq_to_nits(v) / white for v in range(65536)]
    lr, lg, lb = ([k * n for n in nits] for k in (0.2627, 0.6780, 0.0593))  # BT.2020
    linear = [srgb_to_linear(v) for v in range(256)]
    sr, sg, sb = ([k * n for n in linear] for k in (0.2126, 0.7152, 0.0722))  # BT.709

    hdr_x = [x * hw // sw for x in xs]  # the two may differ by a pixel after scaling
    hdr_get = [row_getter([x * 4 + c for x in hdr_x]) for c in range(3)]
    sdr_get = [row_getter([x * channels + c for x in xs]) for c in range(3)]

    hdr_lum, sdr_lum = [], []
    for y in ys:
        hy = y * hh // sh
        high = hi[hy * hw * 4:(hy + 1) * hw * 4]
        low = lo[hy * hw * 4:(hy + 1) * hw * 4]
        row = pixels[y * stride:y * stride + sw * channels]
        hdr_lum.extend(lr[a << 8 | b] + lg[c << 8 | d] + lb[e << 8 | f]
                       for a, b, c, d, e, f in zip(hdr_get[0](high), hdr_get[0](low),
                                                   hdr_get[1](high), hdr_get[1](low),
                                                   hdr_get[2](high), hdr_get[2](low)))
        sdr_lum.extend(sr[r] + sg[g] + sb[b] for r, g, b in zip(*(get(row) for get in sdr_get)))
    return len(xs), len(ys), hdr_lum, sdr_lum


def gain_map(hdr_lum, sdr_lum, hdr_scale):
    """8-bit map and log2 range of HDR over SDR luminance, which is what
    ISO 21496-1 gain maps hold whichever picture is the base (readers apply
    them with negative weight to an HDR base). hdr_scale converts HDR
    luminance to the units the format counts in.

    The pointer is only in the SDR picture: where it is near-black the ratio
    doesn't count for the top of the range, and darkening stops at 2x.
    """
    ratios = [(h * hdr_scale + OFFSET) / (s + OFFSET) for h, s in zip(hdr_lum, sdr_lum)]
    usable = [r for r, s in zip(ratios, sdr_lum) if s >= 0.05] or ratios
    high = math.log2(max(usable))
    low = min(math.log2(max(min(ratios), 0.5)), high - 0.01)
    steps = [2 ** (low + (high - low) * (k + 0.5) / 255) for k in range(255)]
    return bytes(map(functools.partial(bisect.bisect, steps), ratios)), low, high


def gst_rows(data, width, height, channels, stride):
    # GStreamer's raw video rows are padded to 4 bytes.
    padded = (width * channels + 3) & ~3
    if stride == padded:
        return data.ljust(padded * height, b'\0')
    return b''.join(data[y * stride:y * stride + width * channels].ljust(padded, b'\0')
                    for y in range(height))


def encode_jpeg(folder, fmt, width, height, data, quality):
    # jpegenc writes GRAY8 as a one-channel JPEG; colour goes through full-range
    # BT.601 4:4:4 (JFIF's YCbCr, and no chroma blur on text).
    raw, out = os.path.join(folder, f'{fmt}.raw'), os.path.join(folder, f'{fmt}.jpg')
    with open(raw, 'wb') as f:
        f.write(data)
    convert = [] if fmt == 'GRAY8' else \
        ['videoconvert', '!', 'video/x-raw,format=Y444,colorimetry=1:4:0:0', '!']
    subprocess.run(['gst-launch-1.0', '-q', 'filesrc', f'location={raw}',
                    f'blocksize={len(data)}', 'num-buffers=1', '!',
                    f'video/x-raw,format={fmt},width={width},height={height},framerate=0/1', '!',
                    *convert, 'jpegenc', f'quality={quality}', '!', 'filesink', f'location={out}'],
                   check=True, stdout=subprocess.DEVNULL)
    with open(out, 'rb') as f:
        return f.read()


def segment(marker, *parts):
    payload = b''.join(parts)
    return bytes([0xFF, marker]) + struct.pack('>H', len(payload) + 2) + payload


def split_jpeg(jpeg):
    """(JFIF APP0 segments, other header segments, SOS to EOI)."""
    pos, jfif, other = 2, [], []
    while jpeg[pos] == 0xFF and jpeg[pos + 1] != 0xDA:
        end = pos + 2 + struct.unpack('>H', jpeg[pos + 2:pos + 4])[0]
        marker = jpeg[pos + 1]
        if marker == 0xE0:
            jfif.append(jpeg[pos:end])
        elif not 0xE1 <= marker <= 0xEF:  # our metadata replaces any other APPn
            other.append(jpeg[pos:end])
        pos = end
    return b''.join(jfif), b''.join(other), jpeg[pos:]


def xmp(attributes, body=''):
    return ('<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2">'
            '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" '
            f'{attributes}>{body}</rdf:Description></rdf:RDF></x:xmpmeta>').encode()


def mpf(primary_size, secondary_size, secondary_offset):
    # CIPA DC-007 index of the two JPEGs. Offsets count from the "MM" header.
    tags = (struct.pack('>HHI4s', 0xB000, 7, 4, b'0100') +  # version
            struct.pack('>HHII', 0xB001, 4, 1, 2) +  # number of images
            struct.pack('>HHII', 0xB002, 7, 32, 50))  # entries, at offset 50
    entries = (struct.pack('>IIIHH', 0x030000, primary_size, 0, 0, 0) +  # primary
               struct.pack('>IIIHH', 0, secondary_size, secondary_offset, 0, 0))
    return segment(0xE2, b'MPF\0', b'MM\0\x2a', struct.pack('>IH', 8, 3), tags,
                   struct.pack('>I', 0), entries)


def write_ultrahdr(path, base, gain, low, high):
    """Joins the SDR JPEG and the gain map JPEG as Ultra HDR v1.1: Adobe/Google
    XMP (Android 14+, Chrome) and ISO 21496-1 (iOS 18+, newer Android)."""
    d = 1_000_000
    n = lambda x: round(x * d)
    headroom = max(high, 0.01)
    gain_xmp = xmp(f'rdf:about="" hdrgm:Version="1.0" hdrgm:GainMapMin="{low:.6f}" '
                   f'hdrgm:GainMapMax="{high:.6f}" hdrgm:Gamma="1" hdrgm:OffsetSDR="{OFFSET}" '
                   f'hdrgm:OffsetHDR="{OFFSET}" hdrgm:HDRCapacityMin="0" '
                   f'hdrgm:HDRCapacityMax="{headroom:.6f}" hdrgm:BaseRenditionIsHDR="False"')
    # One channel, applied in the base (sRGB) colour space; rationals throughout.
    gain_iso = (struct.pack('>HHB', 0, 0, 0x40) +
                struct.pack('>IIII', 0, 1, n(headroom), d) +  # SDR and HDR headroom
                struct.pack('>iIiIIIiIiI', n(low), d, n(high), d,  # gain min, max
                            1, 1, 1, 64, 1, 64))  # gamma, base and alternate offsets
    jfif, other, rest = split_jpeg(gain)
    secondary = (b'\xff\xd8' + jfif + segment(0xE1, XMP_NS, gain_xmp) +
                 segment(0xE2, ISO_NS, gain_iso) + other + rest)

    primary_xmp = xmp(
        'xmlns:Container="http://ns.google.com/photos/1.0/container/" '
        'xmlns:Item="http://ns.google.com/photos/1.0/container/item/" hdrgm:Version="1.0"',
        '<Container:Directory><rdf:Seq>'
        '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" '
        'Item:Mime="image/jpeg"/></rdf:li>'
        '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" '
        f'Item:Mime="image/jpeg" Item:Length="{len(secondary)}"/></rdf:li>'
        '</rdf:Seq></Container:Directory>')
    jfif, other, rest = split_jpeg(base)
    head = (b'\xff\xd8' + jfif + segment(0xE1, XMP_NS, primary_xmp) +
            segment(0xE2, ISO_NS, bytes(4)) + other)  # ISO version only; MPF just before SOS
    primary_size = len(head) + len(mpf(0, 0, 0)) + len(rest)
    head += mpf(primary_size, len(secondary), primary_size - len(head) - 8)
    with open(path, 'wb') as f:
        f.write(head + rest + secondary)


def write_jpeg(path, hdr, sdr, quality, white):
    width, height, stride, channels, pixels = sdr
    map_w, map_h, hdr_lum, sdr_lum = sample_luminance(hdr, sdr, white)
    gains, low, high = gain_map(hdr_lum, sdr_lum, 1)
    with tempfile.TemporaryDirectory(prefix='screenshot-plus-') as folder:
        base = encode_jpeg(folder, 'RGBA' if channels == 4 else 'RGB', width, height,
                           gst_rows(pixels, width, height, channels, stride), quality)
        gain = encode_jpeg(folder, 'GRAY8', map_w, map_h,
                           gst_rows(gains, map_w, map_h, 1, map_w), quality)
    write_ultrahdr(path, base, gain, low, high)


# --- AVIF with a gain map ---------------------------------------------------

def boxes(data, start=0, end=None):
    """(type, payload start, end) of each ISOBMFF box in data[start:end]."""
    end = len(data) if end is None else end
    while start + 8 <= end:
        size, kind = struct.unpack('>I4s', data[start:start + 8])
        head = 8
        if size == 1:
            size, head = struct.unpack('>Q', data[start + 8:start + 16])[0], 16
        elif size == 0:
            size = end - start
        yield kind, start + head, start + size
        start += size


def read_avif(data):
    """av1C, pixi, ispe and coded data of a one-image AVIF from ffmpeg."""
    meta = next((s, e) for kind, s, e in boxes(data) if kind == b'meta')
    parts = {kind: (s, e) for kind, s, e in boxes(data, meta[0] + 4, meta[1])}
    item = {}
    s, e = parts[b'iprp']
    ipco = next((s2, e2) for kind, s2, e2 in boxes(data, s, e) if kind == b'ipco')
    for kind, s2, e2 in boxes(data, *ipco):
        if kind in (b'av1C', b'pixi', b'ispe'):
            item[kind.decode()] = data[s2 - 8:e2]
    s, e = parts[b'iloc']
    version = data[s]
    offset_size, length_size = data[s + 4] >> 4, data[s + 4] & 15
    base_size, index_size = data[s + 5] >> 4, data[s + 5] & 15 if version else 0
    p = s + 6
    count_size = 4 if version == 2 else 2
    count, p = int.from_bytes(data[p:p + count_size], 'big'), p + count_size
    read = lambda n: (int.from_bytes(data[p:p + n], 'big'), p + n)
    for _ in range(count):
        item_id, p = read(4 if version == 2 else 2)
        p += 2 if version else 0  # construction method: ffmpeg uses file offsets
        p += 2  # data reference index
        base, p = read(base_size)
        extents, p = read(2)
        chunks = []
        for _ in range(extents):
            p += index_size
            offset, p = read(offset_size)
            length, p = read(length_size)
            chunks.append(data[base + offset:base + offset + length])
        if item_id == 1:
            item['data'] = b''.join(chunks)
    return item


def encode_avif(folder, name, raw, size, pix_fmt, filters, colour, crf):
    """One AV1 still through ffmpeg, returned as read_avif() parts."""
    path = os.path.join(folder, f'{name}.avif')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                    '-f', 'rawvideo', '-pix_fmt', pix_fmt, '-s', '%dx%d' % size, '-i', '-',
                    *filters, *colour, '-c:v', 'libaom-av1', '-still-picture', '1',
                    '-cpu-used', '6', '-row-mt', '1', '-crf', str(crf), '-f', 'avif', path],
                   input=bytes(raw), check=True)
    with open(path, 'rb') as f:
        return read_avif(f.read())


def box(kind, *parts):
    payload = b''.join(parts)
    return struct.pack('>I', 8 + len(payload)) + kind + payload


def full_box(kind, version, flags, *parts):
    return box(kind, struct.pack('>I', version << 24 | flags), *parts)


def nclx(primaries, transfer, matrix):
    return box(b'colr', b'nclx', struct.pack('>HHHB', primaries, transfer, matrix, 0x80))


def tone_map_payload(base_headroom, low, high):
    # ToneMapImage (ISO/IEC 23008-12) holding ISO 21496-1 metadata for one
    # channel, applied in the base colour space; rationals over a million.
    d = 1_000_000
    n = lambda x: round(x * d)
    return (bytes([0]) + struct.pack('>HHB', 0, 0, 0x40) +
            struct.pack('>IIII', n(base_headroom), d, 0, 1) +  # base, alternate headroom
            struct.pack('>iIiIIIiIiI', n(low), d, n(high), d,  # gain map min, max
                        1, 1, 1, 64, 1, 64))  # gamma, base and alternate offsets


def write_gain_map_avif(path, base, gain, tone_map):
    """Item 1 is the base (primary, what viewers without gain maps show), item
    2 the 'tmap' derived image (base + gain map, preferred through an altr
    group) and item 3 the hidden gain map. Same layout as libavif."""
    props = [base['ispe'], base['pixi'], base['av1C'], nclx(9, 16, 9),  # 1-4: BT.2020 PQ
             nclx(1, 13, 1),  # 5: the tmap result is sRGB
             gain['ispe'], gain['pixi'], gain['av1C'], nclx(2, 2, 2)]  # 6-9
    ipma = full_box(b'ipma', 0, 0, struct.pack('>I', 3),
                    struct.pack('>HB4B', 1, 4, 1, 2, 0x80 | 3, 4),  # 0x80: essential
                    struct.pack('>HB3B', 2, 3, 1, 2, 5),
                    struct.pack('>HB4B', 3, 4, 6, 7, 0x80 | 8, 9))
    infe = lambda item, kind, flags=0: full_box(b'infe', 2, flags, struct.pack('>HH', item, 0), kind, b'\0')
    chunks = [(2, tone_map), (3, gain['data']), (1, base['data'])]

    def meta(offsets):
        iloc = full_box(b'iloc', 0, 0, bytes([0x44, 0x00]), struct.pack('>H', len(offsets)),
                        *(struct.pack('>HHHII', item, 0, 1, offset, length)
                          for item, offset, length in offsets))
        return full_box(b'meta', 0, 0,
                        full_box(b'hdlr', 0, 0, bytes(4), b'pict', bytes(12), b'\0'),
                        full_box(b'pitm', 0, 0, struct.pack('>H', 1)),
                        iloc,
                        full_box(b'iinf', 0, 0, struct.pack('>H', 3),
                                 infe(1, b'av01'), infe(2, b'tmap'), infe(3, b'av01', 1)),
                        full_box(b'iref', 0, 0, box(b'dimg', struct.pack('>HHHH', 2, 2, 1, 3))),
                        box(b'iprp', box(b'ipco', *props), ipma),
                        box(b'grpl', full_box(b'altr', 0, 0, struct.pack('>IIII', 4, 2, 2, 1))))

    ftyp = box(b'ftyp', b'avif', bytes(4), b'avif', b'mif1', b'miaf', b'MA1A', b'tmap')
    position = len(ftyp) + len(meta([(item, 0, 0) for item, _ in chunks])) + 8
    offsets = []
    for item, data in chunks:
        offsets.append((item, position, len(data)))
        position += len(data)
    with open(path, 'wb') as f:
        f.write(ftyp + meta(sorted(offsets)) + box(b'mdat', *(data for _, data in chunks)))


def write_avif(path, hdr, sdr, quality, white):
    width, height, hi, lo = hdr
    map_w, map_h, hdr_lum, sdr_lum = sample_luminance(hdr, sdr, white)
    # Gain-map maths counts 1.0 as 203 nits; GNOME's SDR white may sit elsewhere.
    scale = white / REFERENCE_WHITE
    peak = max(max(hdr_lum), 1) * scale
    gains, low, high = gain_map(hdr_lum, sdr_lum, scale)

    crf = round(63 - quality * 0.63)  # 100 -> 0, 0 -> 63
    # FFmpeg 8's swscale turns neutral RGB into Cb = Cr = 511 instead of 512,
    # which shows as a green tint of a few percent; zimg's zscale is exact.
    filters = subprocess.run(['ffmpeg', '-hide_banner', '-filters'], capture_output=True, text=True).stdout
    convert = 'zscale=m=2020_ncl:r=full' if ' zscale ' in filters else \
        'scale=out_color_matrix=bt2020:out_range=full'
    with tempfile.TemporaryDirectory(prefix='screenshot-plus-') as folder:
        base = encode_avif(folder, 'base', join_rgb16(width, height, hi, lo), (width, height), 'rgb48be',
                           ['-vf', f'{convert},format=yuv444p10le'],
                           ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084',
                            '-colorspace', 'bt2020nc', '-color_range', 'pc'], crf)
        gain = encode_avif(folder, 'gain', gains, (map_w, map_h), 'gray', [],
                           ['-color_range', 'pc'], crf)
    write_gain_map_avif(path, base, gain, tone_map_payload(max(math.log2(peak), 0.01), low, high))


def main():
    fmt, path = sys.argv[1], sys.argv[2]
    hdr = read_halves(sys.stdin.buffer)
    if fmt == 'jpeg':
        write_jpeg(path, hdr, read_sdr(sys.stdin.buffer), int(sys.argv[3]), float(sys.argv[4]))
    elif fmt == 'avif':
        write_avif(path, hdr, read_sdr(sys.stdin.buffer), int(sys.argv[3]), float(sys.argv[4]))
    else:
        write_png(path, hdr[0], hdr[1], join_rgb16(*hdr))


main()
