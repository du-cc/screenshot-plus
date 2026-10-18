import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Naming from './lib/naming.js';

const tilde = path => path.startsWith(GLib.get_home_dir())
    ? `~${path.slice(GLib.get_home_dir().length)}` : path;

// A drop-down bound to a string or int key; options are [value, label].
function comboRow(settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({
        title,
        subtitle: subtitle ?? '',
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const isInt = typeof options[0][0] === 'number';
    const get = () => isInt ? settings.get_int(key) : settings.get_string(key);
    const sync = () => {
        const index = options.findIndex(([value]) => value === get());
        row.selected = Math.max(0, index);
    };
    sync();
    row.connect('notify::selected', () => {
        const [value] = options[row.selected];
        if (value !== get()) {
            if (isInt)
                settings.set_int(key, value);
            else
                settings.set_string(key, value);
        }
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max, step) {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.title = title;
    row.subtitle = subtitle ?? '';
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function entryRow(settings, key, title) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class ScreenshotPlusPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window._settings = s;
        window.set_default_size(620, 820);

        window.add(this._filesPage(window, s));
        window.add(this._screenshotsPage(s));
        window.add(this._recordingPage(s));
    }

    _filesPage(window, s) {
        const page = new Adw.PreferencesPage({title: 'Files', icon_name: 'folder-pictures-symbolic'});

        // ---- Folders ----------------------------------------------------------
        const folders = new Adw.PreferencesGroup({title: 'Folders'});
        const folderRow = (key, title, fallback) => {
            const row = new Adw.ActionRow({title});
            const reset = new Gtk.Button({
                icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: 'Use the default', css_classes: ['flat'],
            });
            const choose = new Gtk.Button({
                icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: 'Choose folder', css_classes: ['flat'],
            });
            row.add_suffix(reset);
            row.add_suffix(choose);
            const sync = () => {
                const custom = s.get_string(key);
                row.subtitle = custom ? tilde(custom) : fallback();
                reset.visible = Boolean(custom);
            };
            reset.connect('clicked', () => s.set_string(key, ''));
            choose.connect('clicked', () => {
                const dialog = new Gtk.FileDialog({title});
                const current = Gio.File.new_for_path(key === 'folder'
                    ? Naming.screenshotsDir(s) : Naming.recordingsDir(s));
                if (current.query_exists(null))
                    dialog.initial_folder = current;
                dialog.select_folder(window, null, (d, result) => {
                    try {
                        s.set_string(key, d.select_folder_finish(result).get_path());
                    } catch {} // cancelled
                });
            });
            s.connect(`changed::${key}`, sync);
            s.connect('changed::folder', sync);
            sync();
            return row;
        };
        folders.add(folderRow('folder', 'Screenshots', () => `${tilde(Naming.screenshotsDir(s))} (default)`));
        folders.add(folderRow('recording-folder', 'Recordings', () => 'Same as screenshots'));
        page.add(folders);

        // ---- Names ------------------------------------------------------------
        const names = new Adw.PreferencesGroup({
            title: 'Subfolders and names',
            description: 'ShareX-style patterns. The second name is used when the app ' +
                'in the picture is known, the first otherwise. A / in the subfolder makes nested folders.',
        });
        names.add(entryRow(s, 'subfolder', 'Subfolder'));
        names.add(entryRow(s, 'name-pattern', 'File name'));
        names.add(entryRow(s, 'name-pattern-app', 'File name when the app is known'));

        const example = new Adw.ActionRow({title: 'Example', css_classes: ['property']});
        const syncExample = () => {
            const info = {process: 'brave', appName: 'Brave Browser', title: 'New Tab',
                width: 2880, height: 1800, counter: s.get_int('counter')};
            const folder = Naming.expand(s.get_string('subfolder'), info);
            const withApp = Naming.expand(s.get_string('name-pattern-app'), info);
            const plain = Naming.expand(s.get_string('name-pattern'), info);
            const ext = {png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif'}[s.get_string('image-format')];
            example.subtitle = `${folder}/${plain}.${ext}\n${folder}/${withApp}.${ext}`;
        };
        for (const key of ['subfolder', 'name-pattern', 'name-pattern-app', 'image-format', 'counter'])
            s.connect(`changed::${key}`, syncExample);
        syncExample();
        names.add(example);

        const tokens = new Adw.ExpanderRow({title: 'Pattern tokens'});
        for (const [token, meaning] of Naming.TOKENS) {
            tokens.add_row(new Adw.ActionRow({
                title: token, subtitle: meaning, css_classes: ['property'],
                subtitle_selectable: true,
            }));
        }
        names.add(tokens);
        page.add(names);

        // ---- Tidy up ----------------------------------------------------------
        const tidy = new Adw.PreferencesGroup({title: 'Tidy up'});
        const tidyRow = new Adw.ActionRow({
            title: 'Sort loose files',
            subtitle: 'Moves screenshots and recordings sitting in the top folder into ' +
                'their subfolders, renamed with the file name pattern.',
        });
        const sortButton = new Gtk.Button({label: 'Sort…', valign: Gtk.Align.CENTER});
        const undoButton = new Gtk.Button({label: 'Undo', valign: Gtk.Align.CENTER});
        tidyRow.add_suffix(undoButton);
        tidyRow.add_suffix(sortButton);
        const syncUndo = () => (undoButton.sensitive = Naming.canUndoTidy());
        syncUndo();

        const report = (verb, {moved, failed}) => {
            let title = `${verb} ${moved} file${moved === 1 ? '' : 's'}`;
            if (failed.length) {
                title += `, ${failed.length} failed`;
                console.warn(`Screenshot Plus: ${failed.join('\n')}`);
            }
            window.add_toast(new Adw.Toast({title}));
            syncUndo();
        };
        sortButton.connect('clicked', () => {
            const loose = Naming.findLoose(s);
            if (!loose.length) {
                window.add_toast(new Adw.Toast({title: 'Nothing to sort'}));
                return;
            }
            const roots = [...new Set(loose.map(l => tilde(l.root)))].join(' and ');
            const dialog = new Adw.AlertDialog({
                heading: `Sort ${loose.length} files?`,
                body: `They move from ${roots} into subfolders and get new names from your ` +
                    'pattern. Undo puts them back.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('sort', 'Sort');
            dialog.set_response_appearance('sort', Adw.ResponseAppearance.SUGGESTED);
            dialog.connect('response', (d, response) => {
                if (response === 'sort')
                    report('Sorted', Naming.tidyUp(s));
            });
            dialog.present(window);
        });
        undoButton.connect('clicked', () => report('Put back', Naming.undoTidy()));
        tidy.add(tidyRow);
        page.add(tidy);

        return page;
    }

    _screenshotsPage(s) {
        const page = new Adw.PreferencesPage({title: 'Screenshots', icon_name: 'camera-photo-symbolic'});

        const format = new Adw.PreferencesGroup({title: 'Image'});
        format.add(comboRow(s, 'image-format', 'Format', null, [
            ['png', 'PNG (lossless)'],
            ['jpeg', 'JPEG'],
            ['webp', 'WebP'],
            ['avif', 'AVIF'],
        ]));
        const quality = spinRow(s, 'image-quality', 'Quality',
            'For JPEG, WebP, AVIF and HDR JPEG/AVIF', 1, 100, 1);
        format.add(quality);
        format.add(comboRow(s, 'image-scale', 'Size', null, [
            [100, 'Full resolution'],
            [0, 'Logical size (undo display scaling)'],
            [75, '75%'],
            [50, '50%'],
            [25, '25%'],
        ]));
        page.add(format);

        const hdr = new Adw.PreferencesGroup({
            title: 'HDR',
            description: 'While a screen is in HDR mode, the screenshot tool always shows it in HDR. ' +
                'This switch also saves area and full-screen shots with their HDR highlights. ' +
                'Window shots, the clipboard and the pointer stay SDR. ' +
                'AVIF keeps the HDR picture plus a gain map to SDR: GNOME\'s Image Viewer shows it in HDR, ' +
                'and so do gain-map viewers (iPhone with iOS 18+, Chrome). Ultra HDR JPEG is a normal JPEG ' +
                'plus a gain map to HDR, for Android phones; desktop viewers show it in SDR. PNG holds only ' +
                'the HDR pixels, which viewers without HDR show too dark or washed out.',
        });
        hdr.add(switchRow(s, 'hdr', 'HDR screenshots'));
        const hdrFormat = comboRow(s, 'hdr-format', 'HDR format', null, [
            ['avif', 'AVIF with gain map (desktop + phones; uses ffmpeg)'],
            ['jpeg', 'Ultra HDR JPEG (Android phones; uses GStreamer)'],
            ['png', 'PNG, 16-bit PQ (desktop only, large)'],
        ]);
        s.bind('hdr', hdrFormat, 'sensitive', Gio.SettingsBindFlags.GET);
        hdr.add(hdrFormat);
        page.add(hdr);

        const after = new Adw.PreferencesGroup({title: 'After capture'});
        after.add(switchRow(s, 'copy-to-clipboard', 'Copy to clipboard'));
        after.add(switchRow(s, 'show-notification', 'Show notification'));
        after.add(switchRow(s, 'play-sound', 'Play camera sound'));
        page.add(after);

        return page;
    }

    _recordingPage(s) {
        const page = new Adw.PreferencesPage({title: 'Recording', icon_name: 'media-record-symbolic'});

        const video = new Adw.PreferencesGroup({
            title: 'Video',
            description: 'Applies to Ctrl+Shift+Alt+R and the record switch in the screenshot tool.',
        });
        video.add(comboRow(s, 'video-format', 'Format', 'H.264 plays everywhere; HEVC and AV1 are smaller', [
            ['mp4-h264', 'MP4 · H.264'],
            ['mp4-hevc', 'MP4 · H.265 / HEVC'],
            ['mp4-av1', 'MP4 · AV1'],
            ['webm-vp9', 'WebM · VP9'],
        ]));
        video.add(comboRow(s, 'video-encoder', 'Encoder', null, [
            ['auto', 'Automatic (GPU, then CPU)'],
            ['hardware', 'GPU only (VA-API)'],
            ['software', 'CPU only'],
        ]));
        video.add(spinRow(s, 'video-fps', 'Frame rate',
            'Frames per second, at most; up to the screen\'s refresh rate', 1, 240, 1));
        video.add(comboRow(s, 'video-resolution', 'Resolution', 'Height at most; never scales up', [
            [0, 'Native'],
            [2160, '2160p'],
            [1440, '1440p'],
            [1080, '1080p'],
            [720, '720p'],
            [480, '480p'],
        ]));
        video.add(spinRow(s, 'video-bitrate', 'Bitrate', 'Mbit/s; 0 picks one from size and frame rate',
            0, 500, 1));
        page.add(video);

        const hdr = new Adw.PreferencesGroup({
            title: 'HDR',
            description: 'While the screen is in HDR mode, record 10-bit HDR (BT.2020, PQ) with the GPU ' +
                'encoder. H.264 has no HDR, so HDR recordings use H.265 when H.264 is chosen. ' +
                'Players without HDR support show these washed out.',
        });
        hdr.add(switchRow(s, 'video-hdr', 'HDR recording'));
        page.add(hdr);

        const audio = new Adw.PreferencesGroup({title: 'Audio'});
        audio.add(comboRow(s, 'video-audio', 'Record sound', null, [
            ['none', 'None'],
            ['desktop', 'Desktop sound'],
            ['mic', 'Microphone'],
            ['both', 'Desktop sound and microphone'],
        ]));
        page.add(audio);

        return page;
    }
}
