// Saving screenshots: the file goes where the patterns say, in the chosen
// format and size, optionally as HDR. Mirrors GNOME's own save step
// (_storeScreenshot in ui/screenshot.js), which extensions cannot reach.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import * as Naming from './naming.js';

Gio._promisify(Shell.Screenshot, 'composite_to_stream');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_async');

const EXTENSIONS = {png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif'};

// What the picture is of, for %pn, %an and %t. Null for the desktop and
// shell surfaces, which then use the plain name pattern.
export function describeWindow(window) {
    if (!window || window.skip_taskbar ||
        window.get_window_type() === Meta.WindowType.DESKTOP)
        return null;

    // Like ShareX's process name. The kernel cuts comm at 15 characters, so
    // take the executable's name when comm is the start of it.
    let process = '';
    const pid = window.get_pid();
    if (pid > 0) {
        try {
            const [, bytes] = GLib.file_get_contents(`/proc/${pid}/comm`);
            process = new TextDecoder().decode(bytes).trim();
            const exe = GLib.path_get_basename(GLib.file_read_link(`/proc/${pid}/exe`));
            if (exe.startsWith(process))
                process = exe;
        } catch {}
    }
    process ||= window.get_wm_class_instance() || window.get_wm_class() || '';
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return {process, appName: app?.get_name() ?? '', title: window.get_title() ?? ''};
}

// Topmost window under a point in stage coordinates.
export function windowAt(x, y) {
    const workspace = global.workspace_manager.get_active_workspace();
    const actors = global.get_window_actors();
    for (let i = actors.length - 1; i >= 0; i--) {
        const window = actors[i].get_meta_window();
        if (!actors[i].visible || window.minimized || !window.located_on_workspace(workspace))
            continue;
        const r = window.get_frame_rect();
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
            return window;
    }
    return null;
}

// --- HDR -------------------------------------------------------------------
//
// GNOME renders screenshots as 8-bit sRGB. For HDR we render the stage again
// into a 16-bit float texture in the screen's own PQ colour state. JavaScript
// can only read 8-bit images back (through Shell.Screenshot), so the GPU splits
// each 16-bit value into a high-byte and a low-byte image and hdr-encode.py
// joins them again.

// Whether a screen is in HDR mode (its output is PQ-encoded).
export function isHdrView(view) {
    return Boolean(view.output_color_state?.to_string().includes('transfer function: PQ'));
}

// The luminance SDR white is shown at in nits (GNOME's HDR brightness), which
// is what the SDR screenshot maps to white.
function referenceLuminance(colorState) {
    return Number(/ ref lum: ([\d.]+)/.exec(colorState.to_string())?.[1]) || 203;
}

// The colour state of the first screen in HDR mode, or null.
export function hdrColorState() {
    const view = global.stage.peek_stage_views().find(isHdrView);
    return view?.output_color_state ?? null;
}

// Renders the whole stage, without the pointer, at the same scale GNOME uses
// for its frozen screenshot. Returns {texture, scale, white}.
export function paintHdr(colorState) {
    const stage = global.stage;
    const [width, height] = global.display.get_size();
    const rect = new Mtk.Rectangle({x: 0, y: 0, width, height});
    const [, w, h, scale] = stage.get_capture_final_size(rect);
    const cogl = stage.context.get_backend().get_cogl_context();
    const texture = Cogl.Texture2D.new_with_format(cogl, w, h,
        Cogl.PixelFormat.RGBA_FP_16161616_PRE);
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    framebuffer.allocate();
    stage.paint_to_framebuffer(framebuffer, rect, scale, colorState,
        Clutter.PaintFlag.NO_CURSORS | Clutter.PaintFlag.CLEAR);
    framebuffer.flush();
    return {texture, scale, white: referenceLuminance(colorState)};
}

const splitShader = high => `
    vec4 q = floor(clamp(cogl_color_out, 0.0, 1.0) * 65535.0 + 0.5);
    vec4 high = floor(q / 256.0);
    cogl_color_out = vec4(${high ? 'high' : 'q - high * 256.0'}.rgb / 255.0, 1.0);`;

// Copies [sx, sy, sw, sh] of a texture into a new w × h texture.
function drawTexture(source, [sx, sy, sw, sh], w, h, format, snippet) {
    const cogl = global.stage.context.get_backend().get_cogl_context();
    const texture = format
        ? Cogl.Texture2D.new_with_format(cogl, w, h, format)
        : Cogl.Texture2D.new_with_size(cogl, w, h);
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    framebuffer.allocate();
    const pipeline = Cogl.Pipeline.new(cogl);
    pipeline.set_layer_texture(0, source);
    const filter = w === sw && h === sh ? Cogl.PipelineFilter.NEAREST : Cogl.PipelineFilter.LINEAR;
    pipeline.set_layer_filters(0, filter, filter);
    pipeline.set_blend('RGBA = ADD(SRC_COLOR, 0)');
    if (snippet)
        pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, null, snippet));
    const W = source.get_width(), H = source.get_height();
    framebuffer.draw_textured_rectangle(pipeline, -1, 1, 1, -1,
        sx / W, sy / H, (sx + sw) / W, (sy + sh) / H);
    framebuffer.flush();
    return texture;
}

async function texturePixels(texture) {
    const stream = Gio.MemoryOutputStream.new_resizable();
    const pixbuf = await Shell.Screenshot.composite_to_stream(
        texture, 0, 0, -1, -1, 1, null, 0, 0, 1, stream);
    stream.close(null);
    return pixbuf.get_pixels();
}

// --- Notifications ---------------------------------------------------------

let notificationSource = null;

function getNotificationSource() {
    if (!notificationSource) {
        notificationSource = new MessageTray.Source({
            title: 'Screen Capture',
            iconName: 'screenshooter-symbolic',
        });
        notificationSource.connect('destroy', () => (notificationSource = null));
        Main.messageTray.add(notificationSource);
    }
    return notificationSource;
}

export function destroyNotificationSource() {
    notificationSource?.destroy();
}

/**
 * Shows a capture notification; clicking opens the file.
 *
 * @param {object} params
 * @param {string} params.title - notification title
 * @param {string} [params.body] - notification body
 * @param {Gio.File} [params.file] - the saved file
 * @param {Gio.Icon} [params.gicon] - thumbnail
 */
export function notify({title, body = '', file = null, gicon = null}) {
    const notification = new MessageTray.Notification({
        source: getNotificationSource(),
        title,
        body,
        gicon,
        datetime: GLib.DateTime.new_now_local(),
        isTransient: true,
    });

    if (file) {
        notification.addAction('Show in Files', () => {
            const app = Gio.app_info_get_default_for_type('inode/directory', false);
            app?.launch([file], global.create_app_launch_context(0, -1));
        });
        notification.connect('activated', () => {
            try {
                Gio.app_info_launch_default_for_uri(
                    file.get_uri(), global.create_app_launch_context(0, -1));
            } catch (e) {
                logError(e, 'Error opening capture');
            }
            Main.overview.hide();
            Main.panel.closeCalendar();
        });
    }
    getNotificationSource().addNotification(notification);
}

function thumbnail(pixbuf) {
    const cogl = global.stage.context.get_backend().get_cogl_context();
    const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
    content.set_bytes(cogl, pixbuf.read_pixel_bytes(), Cogl.PixelFormat.RGBA_8888,
        pixbuf.width, pixbuf.height, pixbuf.rowstride);
    return content;
}

// --- Saving ----------------------------------------------------------------

function encode(pixbuf, type, keys = [], values = []) {
    return new Promise((resolve, reject) => {
        const stream = Gio.MemoryOutputStream.new_resizable();
        pixbuf.save_to_streamv_async(stream, type, keys, values, null, (_p, result) => {
            try {
                GdkPixbuf.Pixbuf.save_to_stream_finish(result);
                stream.close(null);
                resolve(stream.steal_as_bytes());
            } catch (e) {
                reject(e);
            }
        });
    });
}

// JPEG has no alpha; put the picture on white.
function flatten(pixbuf) {
    const rgb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, pixbuf.width, pixbuf.height);
    rgb.fill(0xffffffff);
    pixbuf.composite(rgb, 0, 0, pixbuf.width, pixbuf.height, 0, 0, 1, 1,
        GdkPixbuf.InterpType.NEAREST, 255);
    return rgb;
}

function addToRecentFiles(file) {
    const recentFile = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
    const bookmarks = new GLib.BookmarkFile();
    try {
        bookmarks.load_from_file(recentFile);
    } catch (e) {
        if (!e.matches(GLib.FileError, GLib.FileError.NOENT))
            return;
    }
    try {
        bookmarks.add_application(file.get_uri(), GLib.get_prgname(), 'gio open %u');
        bookmarks.to_file(recentFile);
    } catch {}
}

export class Saver {
    constructor(settings, extensionPath) {
        this._settings = settings;
        this._encoder = GLib.build_filenamev([extensionPath, 'lib', 'hdr-encode.py']);
        this._lockdown = new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'});
    }

    // How much to shrink: 1, a percentage, or 1/scale for "logical size".
    _factor(scale) {
        const percent = this._settings.get_int('image-scale');
        if (percent === 0)
            return scale > 1 ? 1 / scale : 1;
        return Math.min(percent, 100) / 100;
    }

    /**
     * Saves a screenshot and copies it to the clipboard, as the settings say.
     *
     * @param {object} shot
     * @param {Cogl.Texture} shot.texture - picture to save
     * @param {number[]} [shot.geometry] - x, y, width, height in texture pixels
     * @param {number} shot.scale - texture scale (display scaling)
     * @param {object} [shot.cursor] - texture, x, y, scale, as GNOME passes it
     * @param {Meta.Window} [shot.window] - the app the picture is of
     * @param {object} [shot.hdr] - {texture, geometry, white} to save as HDR instead
     * @returns {Promise<Gio.File|null>}
     */
    async save(shot) {
        const s = this._settings;
        if (s.get_boolean('play-sound')) {
            global.display.get_sound_player().play_from_theme(
                'screen-capture', 'Screenshot taken', null);
        }

        const toDisk = !this._lockdown.get_boolean('disable-save-to-disk');
        const factor = this._factor(shot.scale);
        // The HDR split runs on the GPU and in threads alongside the SDR picture.
        const hdrPixels = toDisk && shot.hdr ? this._splitHdr(shot.hdr, factor).catch(e => {
            logError(e, 'Screenshot Plus: HDR capture failed, saving SDR instead');
            return null;
        }) : null;

        const [x, y, w, h] = shot.geometry ?? [0, 0, -1, -1];
        const cursor = shot.cursor ?? {texture: null, x: 0, y: 0, scale: 1};
        const stream = Gio.MemoryOutputStream.new_resizable();
        let pixbuf = await Shell.Screenshot.composite_to_stream(
            shot.texture, x, y, w, h, shot.scale,
            cursor.texture, cursor.x, cursor.y, cursor.scale, stream);
        stream.close(null);
        let png = stream.steal_as_bytes();

        if (factor < 1) {
            pixbuf = pixbuf.scale_simple(
                Math.max(1, Math.round(pixbuf.width * factor)),
                Math.max(1, Math.round(pixbuf.height * factor)),
                GdkPixbuf.InterpType.BILINEAR);
            png = null;
        }

        if (s.get_boolean('copy-to-clipboard')) {
            png ??= await encode(pixbuf, 'png');
            St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', png);
        }

        let file = null;
        if (toDisk) {
            const info = {...describeWindow(shot.window), width: pixbuf.width, height: pixbuf.height};
            const hdr = await hdrPixels;
            if (hdr) {
                try {
                    file = await this._encodeHdr(hdr, info, pixbuf);
                } catch (e) {
                    logError(e, 'Screenshot Plus: HDR save failed, saving SDR instead');
                }
            }
            file ??= await this._saveSdr(pixbuf, png, info);
            addToRecentFiles(file);
        }

        if (s.get_boolean('show-notification')) {
            notify({
                title: 'Screenshot captured',
                body: s.get_boolean('copy-to-clipboard')
                    ? 'You can paste the image from the clipboard' : '',
                file,
                gicon: thumbnail(pixbuf),
            });
        }
        return file;
    }

    async _saveSdr(pixbuf, png, info) {
        const s = this._settings;
        const format = s.get_string('image-format');
        const quality = String(s.get_int('image-quality'));
        let bytes;
        if (format === 'png')
            bytes = png ?? await encode(pixbuf, 'png');
        else if (format === 'jpeg')
            bytes = await encode(flatten(pixbuf), 'jpeg', ['quality'], [quality]);
        else
            bytes = await encode(pixbuf, format, ['quality'], [quality]);

        const file = Naming.createFile(s, Naming.screenshotsDir(s), EXTENSIONS[format], info);
        try {
            await file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            file.delete(null);
            throw e;
        }
        return file;
    }

    // Scales and splits the 16-bit capture; resolves {width, height, high, low, white}.
    async _splitHdr(hdr, factor) {
        let source = hdr.texture;
        let [x, y, w, h] = hdr.geometry;
        const outW = Math.max(1, Math.round(w * factor));
        const outH = Math.max(1, Math.round(h * factor));
        if (outW !== w || outH !== h) {
            source = drawTexture(source, [x, y, w, h], outW, outH,
                Cogl.PixelFormat.RGBA_FP_16161616_PRE);
            [x, y, w, h] = [0, 0, outW, outH];
        }
        const [high, low] = await Promise.all([true, false].map(part =>
            texturePixels(drawTexture(source, [x, y, w, h], w, h, null, splitShader(part)))));
        return {width: w, height: h, high, low, white: hdr.white};
    }

    async _encodeHdr({width: w, height: h, high, low, white}, info, pixbuf) {
        const s = this._settings;
        const format = s.get_string('hdr-format');
        const encoder = new TextEncoder();
        const parts = [encoder.encode(`${w} ${h}\n`), high.subarray(0, w * h * 4), low.subarray(0, w * h * 4)];
        // Gain maps go between the HDR and the SDR picture, so that goes too.
        if (format !== 'png') {
            const {width, height, rowstride, n_channels: channels} = pixbuf;
            parts.push(encoder.encode(`${width} ${height} ${rowstride} ${channels}\n`),
                pixbuf.get_pixels().subarray(0, rowstride * (height - 1) + width * channels));
        }
        const input = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
        let offset = 0;
        for (const part of parts) {
            input.set(part, offset);
            offset += part.length;
        }

        const file = Naming.createFile(s, Naming.screenshotsDir(s), EXTENSIONS[format],
            {...info, width: w, height: h});
        const proc = Gio.Subprocess.new(
            ['python3', '-I', this._encoder, format, file.get_path(), String(s.get_int('image-quality')),
                String(white)],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [, , stderr] = await proc.communicate_async(new GLib.Bytes(input), null);
        if (!proc.get_successful()) {
            file.delete(null);
            throw new Error(new TextDecoder().decode(stderr?.toArray() ?? new Uint8Array()).trim() ||
                'hdr-encode.py failed');
        }
        return file;
    }
}
