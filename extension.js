// Screenshot Plus
// GNOME's screenshot tool (Print, Shift+Print, Alt+Print, Ctrl+Shift+Alt+R),
// but files land ShareX-style (Screenshots/2026-10/brave_x8Kd02LmQx.png) and
// format, size, HDR, frame rate, codec and audio follow the preferences.
//
// GNOME's UI stays; only its save step, its recorder and the two direct
// screenshot shortcuts are swapped for ours.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Capture from './lib/capture.js';
import * as Naming from './lib/naming.js';
import {Recorder, prewarm} from './lib/recorder.js';
import {StopButton} from './lib/stop-button.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');

const UI_MODE_SCREENSHOT = 0; // UIMode in ui/screenshot.js
const UI_MODE_SCREENSHOT_ONLY = 2; // apps asking through the screenshot portal
const UI_MODES = Shell.ActionMode.ALL & ~Shell.ActionMode.LOGIN_SCREEN;
const RESTRICTED_MODES = UI_MODES & ~(Shell.ActionMode.LOCK_SCREEN | Shell.ActionMode.UNLOCK_SCREEN);

export default class ScreenshotPlusExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._saver = new Capture.Saver(this._settings, this.path);
        this._pluginDir = GLib.build_filenamev([this.path, 'lib', 'gst']);
        this._injections = new InjectionManager();
        prewarm(this._pluginDir);

        const ui = Main.screenshotUI;
        const proto = Object.getPrototypeOf(ui);
        const ext = this;

        // Before the UI freezes the screen: note the focused app, and on a
        // screen in HDR mode render a 16-bit HDR copy of it. That copy is what
        // the UI shows (GNOME's own copy is SDR, so HDR content would dim) and
        // what HDR screenshots are saved from.
        this._injections.overrideMethod(proto, 'open', open => async function (mode = UI_MODE_SCREENSHOT) {
            const fresh = !this.visible && !this._openingCoroutineInProgress &&
                !this._screencastInProgress;
            if (fresh) {
                this._spFocus = global.display.focus_window;
                this._spHdr = null;
                const state = Capture.hdrColorState();
                if (state) {
                    try {
                        this._spHdr = {...Capture.paintHdr(state), state};
                    } catch (e) {
                        logError(e, 'Screenshot Plus: HDR capture failed');
                    }
                }
            }
            await open.call(this, mode);
            if (fresh && this._spHdr && this.visible) {
                this._spSdrContent = this._stageScreenshot.get_content();
                this._stageScreenshot.set_content(
                    Clutter.TextureContent.new_from_texture(this._spHdr.texture, null));
                this._stageScreenshot.set_color_state(this._spHdr.state);
            }
        });
        ui.connectObject('closed', () => this._resetUI(ui), this);

        this._injections.overrideMethod(proto, '_saveScreenshot', () => function () {
            return ext._saveFromUI(this);
        });
        this._injections.overrideMethod(proto, '_startScreencast', () => function () {
            return ext._startRecording(this);
        });
        this._injections.overrideMethod(proto, 'stopScreencast', () => function () {
            return ext._stopRecording(this);
        });
        this._injections.overrideMethod(proto, '_showNotification', () => function (title) {
            Capture.notify({
                title,
                body: this._screencastPath ? 'Click here to view the video' : '',
                file: this._screencastPath ? Gio.File.new_for_path(this._screencastPath) : null,
            });
        });

        this._setKeybindings(
            () => this._screenshotStage().catch(e => logError(e, 'Error capturing screenshot')),
            (display, window) => this._screenshotWindow(window)
                .catch(e => logError(e, 'Error capturing screenshot')));
    }

    disable() {
        const ui = Main.screenshotUI;
        this._hideStopButton();
        if (this._recorder) {
            this._recorder.destroy();
            this._recorder = null;
            delete ui._screencastStarting;
            ui._setScreencastInProgress(false);
        }
        this._injections.clear();
        this._injections = null;
        ui.disconnectObject(this);
        this._resetUI(ui);

        // GNOME's own handlers, as in ui/screenshot.js.
        this._setKeybindings(
            async () => {
                try {
                    const [content] = await new Shell.Screenshot().screenshot_stage_to_content();
                    await Screenshot.captureScreenshot(content.get_texture(), null, 1, null);
                } catch (e) {
                    logError(e, 'Error capturing screenshot');
                }
            },
            async (display, window) => {
                try {
                    const content = window.get_compositor_private().paint_to_content(null);
                    await Screenshot.captureScreenshot(content.get_texture(), null, 1, null);
                } catch (e) {
                    logError(e, 'Error capturing screenshot');
                }
            });

        Capture.destroyNotificationSource();
        this._saver = null;
        this._settings = null;
    }

    _resetUI(ui) {
        if (ui._spSdrContent) {
            ui._stageScreenshot.unset_color_state();
            if (ui._stageScreenshot.get_content())
                ui._stageScreenshot.set_content(ui._spSdrContent);
        }
        ui._spSdrContent = null;
        ui._spHdr = null;
        ui._spFocus = null;
    }

    _setKeybindings(screen, window) {
        const keys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        Main.wm.removeKeybinding('screenshot');
        Main.wm.addKeybinding('screenshot', keys,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, UI_MODES, screen);
        Main.wm.removeKeybinding('screenshot-window');
        Main.wm.addKeybinding('screenshot-window', keys,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT | Meta.KeyBindingFlags.PER_WINDOW,
            RESTRICTED_MODES, window);
    }

    // Shift+Print: the whole screen, no UI.
    async _screenshotStage() {
        const hdrState = this._settings.get_boolean('hdr') && Capture.hdrColorState();
        const hdr = hdrState ? Capture.paintHdr(hdrState) : null;
        const [content, scale] = await new Shell.Screenshot().screenshot_stage_to_content();
        const texture = content.get_texture();
        await this._saver.save({
            texture,
            scale,
            window: global.display.focus_window,
            hdr: hdr && {
                texture: hdr.texture,
                geometry: [0, 0, hdr.texture.get_width(), hdr.texture.get_height()],
                white: hdr.white,
            },
        });
    }

    // Alt+Print: the focused window, no UI.
    async _screenshotWindow(window) {
        if (!window)
            return;
        const actor = window.get_compositor_private();
        const content = actor.paint_to_content(null);
        await this._saver.save({
            texture: content.get_texture(),
            scale: actor.get_resource_scale(),
            window,
        });
    }

    // Replaces ScreenshotUI._saveScreenshot(): same inputs, our Saver.
    async _saveFromUI(ui) {
        let shot = null;
        if (ui._selectionButton.checked || ui._screenButton.checked) {
            // GNOME's SDR copy, even while the UI shows the HDR one.
            const content = ui._spSdrContent ?? ui._stageScreenshot.get_content();
            if (!content)
                return;
            const geometry = ui._getSelectedGeometry(true);
            const cursorTexture = ui._cursor.visible ? ui._cursor.content?.get_texture() : null;
            shot = {
                texture: content.get_texture(),
                geometry,
                scale: ui._scale,
                cursor: {
                    texture: cursorTexture ?? null,
                    x: ui._cursor.x * ui._scale,
                    y: ui._cursor.y * ui._scale,
                    scale: ui._cursorScale,
                },
                window: this._windowFor(ui),
            };
            const hdr = this._settings.get_boolean('hdr') &&
                ui._currentMode !== UI_MODE_SCREENSHOT_ONLY && ui._spHdr;
            if (hdr) {
                const ratio = hdr.scale / ui._scale;
                shot.hdr = {
                    texture: hdr.texture,
                    geometry: geometry.map(v => Math.round(v * ratio)),
                    white: hdr.white,
                };
            }
        } else if (ui._windowButton.checked) {
            const selected = ui._windowSelectors.flatMap(selector => selector.windows())
                .find(win => win.checked);
            const content = selected?.windowContent;
            if (!content)
                return;
            const cursorTexture = ui._cursor.visible ? selected.getCursorTexture()?.get_texture() : null;
            shot = {
                texture: content.get_texture(),
                scale: selected.bufferScale,
                cursor: {
                    texture: cursorTexture ?? null,
                    x: selected.cursorPoint.x * selected.bufferScale,
                    y: selected.cursorPoint.y * selected.bufferScale,
                    scale: ui._cursorScale,
                },
                window: this._windowWithFrame(selected.boundingBox),
            };
        }
        if (!shot)
            return;

        let file = null;
        try {
            file = await this._saver.save(shot);
        } catch (e) {
            logError(e, 'Error capturing screenshot');
        }
        if (file)
            ui.emit('screenshot-taken', file);
    }

    // The app an area or screen capture is of: the window under the middle of
    // the area, or the focused window on the chosen screen.
    _windowFor(ui) {
        const [x, y, w, h] = ui._getSelectedGeometry(false);
        if (ui._selectionButton.checked)
            return Capture.windowAt(x + w / 2, y + h / 2);
        const focus = ui._spFocus;
        const monitor = ui._screenSelectors.findIndex(screen => screen.checked);
        return focus && focus.get_monitor() === monitor ? focus : null;
    }

    _windowWithFrame(box) {
        return global.get_window_actors().map(actor => actor.get_meta_window()).reverse()
            .find(window => {
                const r = window.get_frame_rect();
                return r.x === box.x && r.y === box.y && r.width === box.width && r.height === box.height;
            }) ?? null;
    }

    // Replaces ScreenshotUI._startScreencast().
    async _startRecording(ui) {
        if (ui._windowButton.checked)
            return; // GNOME cannot record a single window either

        const area = ui._getSelectedGeometry(false);
        const drawCursor = ui._cursor.visible;
        const window = this._windowFor(ui);

        if (ui._selectionButton.checked) {
            ui._screencastAreaIndicator.setSelectionRect(...ui._areaSelector.getGeometry());
        } else {
            ui._screencastAreaIndicator.setSelectionRect(...area);
        }

        // Close instantly so the fade-out doesn't get recorded.
        ui.close(true);

        // GNOME treats its idle recorder service quitting as a crash of a
        // running recording unless this is set; it is ours, not the service's.
        ui._screencastStarting = true;
        ui._setScreencastInProgress(true);

        const settings = this._settings;
        const recorder = new Recorder({
            settings,
            pluginDir: this._pluginDir,
            area,
            drawCursor,
            createFile: (ext, width, height) => Naming.createFile(settings,
                Naming.recordingsDir(settings), ext,
                {...Capture.describeWindow(window), width, height}),
            onEnded: error => {
                if (this._recorder !== recorder)
                    return;
                this._hideStopButton();
                if (!error) {
                    ui.stopScreencast();
                    return;
                }
                this._recorder = null;
                delete ui._screencastStarting;
                ui._screencastFailed('RECORDING',
                    new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, error.message));
            },
        });
        this._recorder = recorder;

        try {
            ui._screencastPath = await recorder.start();
            // Shows on screen but not in the recording (lib/stop-button.js).
            if (this._recorder === recorder)
                this._stopButton = new StopButton(area, () => ui.stopScreencast());
        } catch (e) {
            if (this._recorder !== recorder)
                return; // stopped while starting
            this._recorder = null;
            delete ui._screencastStarting;
            ui._screencastFailed('STARTUP', e);
        }
    }

    _hideStopButton() {
        this._stopButton?.destroy();
        this._stopButton = null;
    }

    // Replaces ScreenshotUI.stopScreencast().
    async _stopRecording(ui) {
        this._hideStopButton();
        if (!ui._screencastInProgress)
            return;
        ui._setScreencastInProgress(false);
        delete ui._screencastStarting;

        const recorder = this._recorder;
        this._recorder = null;
        if (!recorder)
            return;
        try {
            ui._screencastPath = await recorder.stop();
        } catch (e) {
            logError(e, 'Error stopping screencast');
            return;
        }
        if (ui._screencastPath)
            ui._showNotification('Screencast recorded');
    }
}
