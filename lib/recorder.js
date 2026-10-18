// Screen recording with the chosen codec, size, frame rate, HDR and audio.
//
// GNOME's recorder service only takes custom settings through a pipeline
// option that forces every frame through the CPU. So this asks Mutter for the
// PipeWire stream itself, as the service does, and encodes it with
// gst-launch-1.0: frames stay on the GPU (DMA-BUF into VA-API) when they can.
//
// Mutter's area streams are SDR and capped at 60 fps. A whole-monitor stream
// runs at the monitor's refresh rate and, on a screen in HDR mode, offers
// 10-bit PQ frames, so above 60 fps or for HDR the monitor is recorded and
// cropped. The stock pipewiresrc can't take those 10-bit frames; gst/
// libgstpipewirehdr.so (built by build-pipewirehdr.sh) adds pipewirehdrsrc.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isHdrView} from './capture.js';

const SCREEN_CAST = 'org.gnome.Mutter.ScreenCast';
const START_TIMEOUT_MS = 10000; // give up on a pipeline that has not started by then
const PLAYING_SETTLE_MS = 1500; // errors in the first frames show up within this
const STOP_TIMEOUT_MS = 10000;
const AREA_MAX_FPS = 60; // Mutter's limit for area streams
const SIGINT = 2;

// va10: the VA encoder for 10-bit HDR; H.264 has none, so HDR uses HEVC.
const FORMATS = {
    'mp4-h264': {ext: 'mp4', va: 'vah264enc', va10: null, parse: 'h264parse', bitsPerPixel: 0.08,
        sw: (kbps, fps) => `x264enc speed-preset=veryfast bitrate=${kbps} key-int-max=${fps * 2} threads=%T`},
    'mp4-hevc': {ext: 'mp4', va: 'vah265enc', va10: 'vah265enc', parse: 'h265parse', bitsPerPixel: 0.05,
        sw: (kbps, fps) => `x265enc speed-preset=ultrafast bitrate=${kbps} key-int-max=${fps * 2}`},
    'mp4-av1': {ext: 'mp4', va: 'vaav1enc', va10: 'vaav1enc', parse: 'av1parse', bitsPerPixel: 0.05,
        sw: kbps => `svtav1enc preset=10 target-bitrate=${kbps}`},
    'webm-vp9': {ext: 'webm', va: 'vavp9enc', va10: 'vavp9enc', parse: 'vp9parse', bitsPerPixel: 0.05,
        sw: (kbps, fps) => `vp9enc deadline=1 cpu-used=8 row-mt=true threads=%T end-usage=vbr target-bitrate=${kbps * 1000} keyframe-max-dist=${fps * 2}`},
};

const MUXERS = {
    mp4: 'mp4mux name=mux fragment-duration=500 fragment-mode=first-moov-then-finalise',
    webm: 'webmmux name=mux',
};

// The VA encoders leave the bitstream's colour "unspecified" and only the
// muxer tags BT.2020/PQ. Firefox takes colour from the bitstream, so HDR
// recordings played there as SDR (VP9: right transfer, BT.601 matrix). These
// ffmpeg bitstream filters write it into the stream, without re-encoding.
// av1_metadata empties the av1C box (mp4mux writes it without config OBUs);
// extract_extradata rebuilds it from the patched sequence header.
function hdrColourFilter(codec, fullRange) {
    const range = fullRange ? 'pc' : 'tv';
    return {
        av1: 'av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9:' +
            `color_range=${range},extract_extradata`,
        h265: 'hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9:' +
            `video_full_range_flag=${fullRange ? 1 : 0}`,
        vp9: `vp9_metadata=color_space=bt2020:color_range=${range}`,
    }[codec];
}

// ffmpeg's probe replaces the container's colour with the bitstream's from
// before the filters, so a plain copy wrote MP4s without a colr box and WebMs
// tagged with the BT.709 matrix; phones and YouTube read those. This puts the
// container back in line with the stream.
function hdrContainerColour(fullRange) {
    return ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084',
        '-colorspace', 'bt2020nc', '-color_range', fullRange ? 'pc' : 'tv'];
}

// How HDR frames are turned into P010 (see lib/vpp-check.py): 'limited',
// 'twopass', 'full' or 'cpu'. Intel's iHD driver converts 10-bit RGB to YUV in
// a shader whose matrix is rounded to 1/128ths; for BT.2020 limited-range YUV
// greys came out green (white Cb = Cr = 504 instead of 512). Via limited-range
// RGB, or to full-range YUV, its rounding keeps them neutral. Rather than
// guess per driver, vpp-check.py measures the conversions once per session
// and the recorder uses only one that came out right, else the CPU.
let hdrConversion = null;

function measureHdrConversion(pluginDir) {
    hdrConversion ??= new Promise(resolve => {
        try {
            const script = GLib.build_filenamev([GLib.path_get_dirname(pluginDir), 'vpp-check.py']);
            launcher(pluginDir, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
                .spawnv(['python3', script])
                .communicate_utf8_async(null, null, (proc, result) => {
                    try {
                        const out = proc.communicate_utf8_finish(result)[1]?.trim().split('\n').pop();
                        const conversion = ['limited', 'twopass', 'full'].includes(out) ? out : 'cpu';
                        console.log(`Screenshot Plus: HDR recordings convert with '${conversion}' (lib/vpp-check.py)`);
                        resolve(conversion);
                    } catch {
                        resolve('cpu');
                    }
                });
        } catch {
            resolve('cpu');
        }
    });
    return hdrConversion;
}

// Pipelines that worked this session, per format, so a later recording does
// not wait on ones that failed.
const workingPipeline = new Map();

function dbusCall(path, iface, method, params, replyType) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(SCREEN_CAST, path, iface, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, result) => {
                try {
                    resolve(conn.call_finish(result)?.deepUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function timeout(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// Rewrites a finished HDR recording with its colour in the bitstream
// (hdrColourFilter). Keeps the file as recorded if ffmpeg is missing or fails.
async function writeHdrColour(file, codec, fullRange) {
    const path = file.get_path();
    const ext = path.split('.').pop();
    const temp = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.path_get_dirname(path), `.${GLib.path_get_basename(path)}.colour`]));
    // Apple devices only play HEVC tagged hvc1.
    const argv = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', path,
        '-map', '0', '-c', 'copy', '-bsf:v', hdrColourFilter(codec, fullRange), ...hdrContainerColour(fullRange),
        ...(codec === 'h265' ? ['-tag:v', 'hvc1'] : []),
        '-f', ext === 'webm' ? 'webm' : 'mp4', temp.get_path()];
    try {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        const stderr = await new Promise((resolve, reject) =>
            proc.communicate_utf8_async(null, null, (p, result) => {
                try {
                    resolve(p.communicate_utf8_finish(result)[2]);
                } catch (e) {
                    reject(e);
                }
            }));
        if (!proc.get_successful())
            throw new Error(stderr?.trim() || 'ffmpeg failed');
        temp.move(file, Gio.FileCopyFlags.OVERWRITE, null, null);
    } catch (e) {
        console.log(`Screenshot Plus: kept ${path} without HDR colour in the stream: ${e.message}`);
        try {
            temp.delete(null);
        } catch {}
    }
}

function audioBranch(mode) {
    const source = device =>
        `pulsesrc ${device ? `device=${device} ` : ''}provide-clock=false ! queue ! ` +
        'audioconvert ! audioresample ! capsfilter caps=audio/x-raw,rate=48000,channels=2';
    const encode = 'opusenc bitrate=160000 ! queue ! mux.';
    switch (mode) {
    case 'desktop': return `${source('@DEFAULT_MONITOR@')} ! ${encode}`;
    case 'mic': return `${source(null)} ! ${encode}`;
    case 'both': return 'audiomixer name=amix ! audioconvert ! ' +
        `capsfilter caps=audio/x-raw,rate=48000,channels=2 ! ${encode} ` +
        `${source('@DEFAULT_MONITOR@')} ! amix. ${source(null)} ! amix.`;
    }
    return '';
}

// The monitor that holds the whole area, or null if it spans several.
function monitorAt(x, y, width, height) {
    const monitors = Main.layoutManager.monitors;
    const index = monitors.findIndex(m =>
        x >= m.x && y >= m.y && x + width <= m.x + m.width && y + height <= m.y + m.height);
    if (index < 0)
        return null;
    const rect = monitors[index];
    const manager = global.backend.get_monitor_manager();
    const connector = manager.get_monitors().map(m => m.get_connector())
        .find(c => manager.get_monitor_for_connector(c) === index);
    const [cx, cy] = [rect.x + rect.width / 2, rect.y + rect.height / 2];
    const view = global.stage.peek_stage_views().find(({layout: l}) =>
        cx >= l.x && cy >= l.y && cx < l.x + l.width && cy < l.y + l.height);
    if (!connector || !view)
        return null;
    return {rect, connector, view, scale: global.display.get_monitor_scale(index)};
}

// GStreamer environment with pipewirehdrsrc, and its own plugin registry so
// the system one isn't rescanned with and without it.
function gstEnvironment(pluginDir) {
    const cache = GLib.build_filenamev([GLib.get_user_cache_dir(), 'screenshot-plus']);
    GLib.mkdir_with_parents(cache, 0o755);
    return {
        GST_PLUGIN_PATH_1_0: pluginDir,
        GST_REGISTRY_1_0: GLib.build_filenamev([cache, 'gst-registry.bin']),
    };
}

function launcher(pluginDir, flags) {
    const l = new Gio.SubprocessLauncher({flags});
    for (const [key, value] of Object.entries(gstEnvironment(pluginDir)))
        l.setenv(key, value, true);
    return l;
}

// Builds the plugin registry (the first gst-launch does) and measures the HDR
// conversion in the background, so the first recording doesn't wait for them.
export function prewarm(pluginDir) {
    measureHdrConversion(pluginDir);
}

export class Recorder {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings - the extension settings
     * @param {string} params.pluginDir - folder with libgstpipewirehdr.so
     * @param {number[]} params.area - x, y, width, height in stage coordinates
     * @param {boolean} params.drawCursor - record the pointer
     * @param {Function} params.createFile - (ext, width, height) => Gio.File
     * @param {Function} params.onEnded - called with an Error if recording
     *   stops on its own; with null if Mutter closed the stream
     */
    constructor({settings, pluginDir, area, drawCursor, createFile, onEnded}) {
        this._settings = settings;
        this._pluginDir = pluginDir;
        this._area = area;
        this._drawCursor = drawCursor;
        this._createFile = createFile;
        this._onEnded = onEnded;
        this._signalIds = [];
        this._run = null;
        this._stopping = false;
        this._hdrCodec = null; // av1/h265/vp9 when recording HDR
        this._hdrFullRange = false;
    }

    get file() {
        return this._file;
    }

    // Starts recording; resolves with the file path once frames are flowing.
    start() {
        this._starting = this._start().catch(async e => {
            await this._closeSession();
            if (this._file && !this._run)
                this._file.delete(null);
            throw e;
        });
        return this._starting;
    }

    async _start() {
        const s = this._settings;
        const [x, y, width, height] = this._area.map(Math.round);
        const formatId = s.get_string('video-format');
        const format = FORMATS[formatId] ?? FORMATS['mp4-h264'];
        const encoder = s.get_string('video-encoder');

        const monitor = monitorAt(x, y, width, height);
        const hdr = Boolean(monitor) && s.get_boolean('video-hdr') && encoder !== 'software' &&
            isHdrView(monitor.view);
        const wantedFps = s.get_int('video-fps');
        const useMonitor = Boolean(monitor) && (wantedFps > AREA_MAX_FPS || hdr);
        const maxFps = useMonitor ? monitor.view.refresh_rate : AREA_MAX_FPS;
        const fps = Math.min(wantedFps, Math.floor(maxFps));
        // Mutter's limit is the exact refresh rate, e.g. 59.94; stay at or under it.
        const fpsCaps = wantedFps > maxFps ? `${Math.floor(maxFps * 1000)}/1000` : `${fps}/1`;

        const props = {
            'is-recording': new GLib.Variant('b', true),
            'cursor-mode': new GLib.Variant('u', this._drawCursor ? 1 : 0),
        };
        [this._session] = await dbusCall('/org/gnome/Mutter/ScreenCast', SCREEN_CAST,
            'CreateSession', new GLib.Variant('(a{sv})', [{}]), '(o)');
        this._subscribe(this._session, `${SCREEN_CAST}.Session`, 'Closed', () => this._onClosed());
        const [stream] = useMonitor
            ? await dbusCall(this._session, `${SCREEN_CAST}.Session`, 'RecordMonitor',
                new GLib.Variant('(sa{sv})', [monitor.connector, props]), '(o)')
            : await dbusCall(this._session, `${SCREEN_CAST}.Session`, 'RecordArea',
                new GLib.Variant('(iiiia{sv})', [x, y, width, height, props]), '(o)');
        const nodeAdded = new Promise(resolve => this._subscribe(stream,
            `${SCREEN_CAST}.Stream`, 'PipeWireStreamAdded', params => resolve(params.deepUnpack()[0])));
        await dbusCall(this._session, `${SCREEN_CAST}.Session`, 'Start', null, null);
        const node = await Promise.race([nodeAdded, timeout(5000).then(() => null)]);
        if (node === null)
            throw new Error('Mutter did not provide a PipeWire stream');

        // Size in pixels: the area, cut from the monitor stream if that's used.
        let crop = '';
        let nativeW, nativeH;
        if (useMonitor) {
            const {rect, scale} = monitor;
            const fullW = Math.round(rect.width * scale), fullH = Math.round(rect.height * scale);
            const left = Math.round((x - rect.x) * scale), top = Math.round((y - rect.y) * scale);
            nativeW = Math.min(fullW - left, Math.round(width * scale));
            nativeH = Math.min(fullH - top, Math.round(height * scale));
            if (nativeW !== fullW || nativeH !== fullH) {
                crop = `videocrop left=${left} top=${top} ` +
                    `right=${fullW - left - nativeW} bottom=${fullH - top - nativeH} ! `;
            }
        } else {
            [, nativeW, nativeH] = global.stage.get_capture_final_size(
                new Mtk.Rectangle({x, y, width, height}));
        }
        let [outW, outH] = [nativeW, nativeH];
        const maxH = s.get_int('video-resolution');
        if (maxH > 0 && outH > maxH)
            [outW, outH] = [Math.round(outW * maxH / outH), maxH];
        outW = Math.max(2, outW - outW % 2);
        outH = Math.max(2, outH - outH % 2);

        this._file = this._createFile(format.ext, outW, outH);

        let candidates = {
            hardware: ['va-dmabuf', 'va-memfd'],
            software: ['sw-dmabuf', 'sw-memfd'],
        }[encoder] ?? ['va-dmabuf', 'va-memfd', 'sw-dmabuf', 'sw-memfd'];
        // HDR only over DMA-BUF: for shared-memory buffers Mutter 50 paints
        // 8-bit ARGB32 (in PQ) whatever format was agreed, so 10-bit caps
        // read those bytes as nonsense colours.
        if (hdr) {
            // Never a GPU conversion that measured wrong: then the CPU does it.
            const conversion = await measureHdrConversion(this._pluginDir);
            candidates = [`hdr-dmabuf-${conversion}`, ...(conversion !== 'cpu' ? ['hdr-dmabuf-cpu'] : []),
                ...candidates];
        }
        const cacheKey = `${formatId}/${encoder}/${hdr}/${useMonitor}`;
        const known = workingPipeline.get(cacheKey);
        if (known)
            candidates = [known, ...candidates.filter(c => c !== known)];

        const errors = [];
        for (const candidate of candidates) {
            if (this._stopping)
                throw new Error('Stopped before recording started');
            // Empty it, so data left by a failed pipeline doesn't count as a start.
            this._file.replace(null, false, Gio.FileCreateFlags.NONE, null).close(null);

            const isHdr = candidate.startsWith('hdr');
            const used = isHdr && !format.va10 ? FORMATS['mp4-hevc'] : format;
            const kbps = s.get_int('video-bitrate') * 1000 ||
                Math.min(100000, Math.max(2000, Math.round(outW * outH * fps * used.bitsPerPixel / 1000)));
            const video = this._videoChain(candidate, used, {fps, fpsCaps, crop, w: outW, h: outH, kbps});
            const description = `${isHdr ? 'pipewirehdrsrc' : 'pipewiresrc'} path=${node} ` +
                'do-timestamp=true keepalive-time=1000 resend-last=true ! ' +
                `${video} ! queue ! mux. ${audioBranch(s.get_string('video-audio'))} ` +
                `${MUXERS[format.ext]} ! filesink`;
            const threads = String(Math.min(Math.max(1, GLib.get_num_processors()), 64));
            const argv = ['gst-launch-1.0', '-e',
                ...description.replaceAll('%T', threads).split(/\s+/).filter(Boolean),
                `location=${this._file.get_path()}`];

            const error = await this._launch(argv);
            if (!error) {
                workingPipeline.set(cacheKey, candidate);
                this._hdrCodec = isHdr ? used.parse.replace('parse', '') : null;
                this._hdrFullRange = candidate === 'hdr-dmabuf-full';
                console.log(`Screenshot Plus: recording with ${candidate} (${used.parse.replace('parse', '')}), ` +
                    `${useMonitor ? `monitor ${monitor.connector}` : 'area'} stream, ` +
                    `${outW}x${outH}@${fpsCaps}, ${kbps} kbit/s`);
                return this._file.get_path();
            }
            errors.push(`${candidate}: ${error}`);
            console.log(`Screenshot Plus: pipeline ${candidate} failed: ${error}`);
        }
        throw new Error(`No recording pipeline worked.\n${errors.join('\n')}`);
    }

    _videoChain(candidate, format, {fps, fpsCaps, crop, w, h, kbps}) {
        const [kind, memory, variant] = candidate.split('-');
        // SDR is tagged plain BT.709; left alone it came out as gamma 2.2
        // (bt470m), and small areas got the BT.601 matrix.
        const encode = encoderName => `${encoderName} rate-control=vbr bitrate=${kbps} ` +
            `target-percentage=80 key-int-max=${fps * 2} ! queue ! ${format.parse}`;
        if (kind === 'hdr') {
            // 10-bit PQ RGB from Mutter (1:1:14:7 = full-range RGB, PQ, BT.2020).
            // Mutter sends a frame only when the screen changes; videorate makes
            // that a constant rate, as YouTube wants for HDR (24 to 60 fps).
            // The variant is the conversion vpp-check.py measured right.
            const input = 'capsfilter caps=video/x-raw(memory:DMABuf),format=DMA_DRM,' +
                `colorimetry=1:1:14:7,max-framerate=${fpsCaps} ! ${crop}vapostproc ! `;
            const size = `width=${w},height=${h}`;
            const yuv = (memory, colorimetry = 'bt2100-pq') =>
                `capsfilter caps=video/x-raw${memory},format=P010_10LE,colorimetry=${colorimetry}`;
            const steps = {
                limited: `${yuv('(memory:VAMemory)')},${size}`,
                // Via limited-range RGB (2:1:14:7).
                twopass: 'capsfilter caps=video/x-raw(memory:VAMemory),format=BGR10A2_LE,' +
                    `colorimetry=2:1:14:7,${size} ! vapostproc ! ${yuv('(memory:VAMemory)')}`,
                // Full-range BT.2020 PQ YUV (1:6:14:7), tagged so afterwards.
                full: `${yuv('(memory:VAMemory)', '1:6:14:7')},${size}`,
                // The GPU only scales and copies; videoconvert does the maths.
                cpu: `capsfilter caps=video/x-raw,format=BGR10A2_LE,colorimetry=1:1:14:7,${size} ! ` +
                    `queue ! videoconvert n-threads=%T ! ${yuv('')}`,
            };
            const memory = variant === 'cpu' ? '' : '(memory:VAMemory)';
            return `${input}${steps[variant]} ! ` +
                `videorate ! capsfilter caps=video/x-raw${memory},framerate=${fpsCaps} ! ` +
                `${encode(format.va10)}`;
        }
        const input = memory === 'dmabuf'
            ? `capsfilter caps=video/x-raw(memory:DMABuf)${kind === 'va' ? ',format=DMA_DRM' : ''},max-framerate=${fpsCaps}`
            : `capsfilter caps=video/x-raw,max-framerate=${fpsCaps}`;
        if (kind === 'va') {
            return `${input} ! ${crop}vapostproc ! ` +
                `capsfilter caps=video/x-raw(memory:VAMemory),format=NV12,colorimetry=bt709,width=${w},height=${h} ! ` +
                encode(format.va);
        }
        const download = memory === 'dmabuf' ? 'glupload ! glcolorconvert ! gldownload ! ' : '';
        return `${input} ! ${download}${crop}queue ! videoscale ! videoconvert n-threads=%T ! ` +
            `capsfilter caps=video/x-raw,format=I420,colorimetry=bt709,width=${w},height=${h} ! ` +
            `${format.sw(kbps, fps)} ! queue ! ${format.parse}`;
    }

    // Runs a pipeline. Resolves null once it is recording: playing for a
    // moment without an error, or data in the file. Otherwise the error text.
    async _launch(argv) {
        const proc = launcher(this._pluginDir,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE).spawnv(argv);
        const run = {proc, log: []};
        let onPlaying, onEnd;
        const playing = new Promise(resolve => (onPlaying = resolve));
        const outputEnded = new Promise(resolve => (onEnd = resolve));
        const output = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const readLine = () => output.read_line_async(GLib.PRIORITY_DEFAULT, null, (o, result) => {
            let line = null;
            try {
                [line] = o.read_line_finish_utf8(result);
            } catch {}
            if (line === null) {
                onEnd();
                return;
            }
            run.log = [...run.log.slice(-29), line];
            if (line.startsWith('New clock')) // gst-launch reached PLAYING
                onPlaying();
            readLine();
        });
        readLine();
        const exited = new Promise(resolve => proc.wait_async(null, () => resolve()));
        run.done = Promise.all([exited, outputEnded]).then(() => ({
            ok: proc.get_successful(),
            error: run.log.filter(l => /ERROR|erroneous/.test(l)).slice(0, 3).join(' '),
        }));

        const waiting = {active: true};
        const started = await Promise.race([
            run.done.then(() => false),
            playing.then(() => timeout(PLAYING_SETTLE_MS)).then(() => true),
            this._waitForData(waiting),
        ]);
        waiting.active = false;
        if (!started || proc.get_if_exited() || proc.get_if_signaled()) {
            if (!proc.get_if_exited() && !proc.get_if_signaled())
                proc.force_exit();
            const {error} = await run.done;
            return error || (run.log.length ? run.log.at(-1) : `no video after ${START_TIMEOUT_MS / 1000} s`);
        }

        this._run = run;
        if (this._destroyed)
            proc.send_signal(SIGINT);
        run.done.then(({ok, error}) => {
            if (this._stopping || this._run !== run)
                return;
            this._run = null;
            this._closeSession();
            this._onEnded?.(new Error(ok ? 'Recording ended' : error || 'Recorder stopped'));
        });
        return null;
    }

    // Resolves true once the file has data, false after START_TIMEOUT_MS.
    _waitForData(waiting) {
        return new Promise(resolve => {
            let waited = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                waited += 200;
                if (!waiting.active)
                    return GLib.SOURCE_REMOVE;
                if (this._fileSize() > 0 || waited >= START_TIMEOUT_MS || this._destroyed) {
                    resolve(this._fileSize() > 0);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        });
    }

    _fileSize() {
        try {
            return this._file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        } catch {
            return 0;
        }
    }

    // Finishes the file. Resolves with its path, or null if nothing was recorded.
    async stop() {
        this._stopping = true;
        await this._starting?.catch(() => {}); // stopped while still trying pipelines
        const run = this._run;
        if (run) {
            run.proc.send_signal(SIGINT); // gst-launch -e: EOS, finish the file, exit
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STOP_TIMEOUT_MS, () => {
                run.proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            const {ok, error} = await run.done;
            GLib.source_remove(id);
            this._run = null;
            if (!ok)
                console.log(`Screenshot Plus: recorder exited with an error: ${error || run.log.at(-1)}`);
        }
        await this._closeSession();
        if (!this._file)
            return null;
        if (this._fileSize() > 0) {
            if (this._hdrCodec)
                await writeHdrColour(this._file, this._hdrCodec, this._hdrFullRange);
            return this._file.get_path();
        }
        this._file.delete(null);
        return null;
    }

    // For extension disable: stop without waiting.
    destroy() {
        this._stopping = true;
        this._destroyed = true;
        this._run?.proc.send_signal(SIGINT);
        this._run = null;
        this._closeSession();
    }

    _onClosed() {
        this._session = null;
        if (!this._stopping)
            this._onEnded?.(null);
    }

    _subscribe(path, iface, signal, callback) {
        this._signalIds.push(Gio.DBus.session.signal_subscribe(SCREEN_CAST, iface, signal, path,
            null, Gio.DBusSignalFlags.NONE, (conn, sender, p, i, s, params) => callback(params)));
    }

    async _closeSession() {
        for (const id of this._signalIds)
            Gio.DBus.session.signal_unsubscribe(id);
        this._signalIds = [];
        const session = this._session;
        this._session = null;
        if (session) {
            try {
                await dbusCall(session, `${SCREEN_CAST}.Session`, 'Stop', null, null);
            } catch {}
        }
    }
}
