// Where captures go and what they are called: ShareX-style patterns such as
// %y-%mo for the month folder and %pn_%ra{10} for the file name.
// Shared by the extension and the preferences window, so GLib/Gio only.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'jxl'];
export const VIDEO_TYPES = ['mp4', 'webm', 'mkv', 'mov'];

// [token, meaning] for the help text in preferences.
export const TOKENS = [
    ['%y', 'year, 2026'], ['%yy', 'year, 26'], ['%mo', 'month, 10'],
    ['%mon', 'month, Oct'], ['%mon2', 'month, October'], ['%d', 'day'],
    ['%h', 'hour'], ['%mi', 'minute'], ['%s', 'second'], ['%ms', 'millisecond'],
    ['%pm', 'AM/PM'], ['%w', 'weekday, Saturday'], ['%w2', 'weekday, Sat'],
    ['%unix', 'Unix time'], ['%ra{n}', 'n random letters and digits'],
    ['%rn{n}', 'n random digits'], ['%rx{n}', 'n random hex digits'],
    ['%guid', 'random GUID'], ['%pn', 'process name, brave'],
    ['%an', 'app name, Brave Browser'], ['%t', 'window title'],
    ['%width', 'width in pixels'], ['%height', 'height in pixels'],
    ['%i', 'counter, counts up'], ['%un', 'user name'], ['%cn', 'computer name'],
];

// Longer names first so %mon2 wins over %mon, %mon over %mo, %unix over %un.
const TOKEN_RE = /%(unix|guid|width|height|mon2|mon|mo|ms|mi|ra|rn|rx|yy|y|d|h|s|pm|w2|w|pn|an|t|cn|un|i)(?:\{(\d+)\})?/g;
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function random(chars, count) {
    let out = '';
    for (let i = 0; i < count; i++)
        out += chars[GLib.random_int_range(0, chars.length)];
    return out;
}

// Characters ShareX replaces in names, plus control characters.
function clean(text) {
    // eslint-disable-next-line no-control-regex
    return (text ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 100);
}

/**
 * Fills in a pattern.
 *
 * @param {string} pattern - e.g. '%pn_%ra{10}'
 * @param {object} info - date (GLib.DateTime), process, appName, title,
 *   width, height, counter; all optional
 * @returns {string}
 */
export function expand(pattern, info = {}) {
    const date = info.date ?? GLib.DateTime.new_now_local();
    return pattern.replace(TOKEN_RE, (match, token, n) => {
        const count = n ? Math.min(parseInt(n), 64) : 1;
        switch (token) {
        case 'y': return date.format('%Y');
        case 'yy': return date.format('%y');
        case 'mo': return date.format('%m');
        case 'mon': return clean(date.format('%b'));
        case 'mon2': return clean(date.format('%B'));
        case 'd': return date.format('%d');
        case 'h': return date.format('%H');
        case 'mi': return date.format('%M');
        case 's': return date.format('%S');
        case 'ms': return String(Math.floor(date.get_microsecond() / 1000)).padStart(3, '0');
        case 'pm': return clean(date.format('%p'));
        case 'w': return clean(date.format('%A'));
        case 'w2': return clean(date.format('%a'));
        case 'unix': return String(date.to_unix());
        case 'ra': return random(ALNUM, count);
        case 'rn': return random('0123456789', count);
        case 'rx': return random('0123456789abcdef', count);
        case 'guid': return GLib.uuid_string_random();
        case 'pn': return clean(info.process);
        case 'an': return clean(info.appName);
        case 't': return clean(info.title);
        case 'width': return String(info.width ?? '');
        case 'height': return String(info.height ?? '');
        case 'i': return String(info.counter ?? 1);
        case 'un': return clean(GLib.get_user_name());
        case 'cn': return clean(GLib.get_host_name());
        }
        return match;
    });
}

function expandHome(path) {
    path = path.trim();
    if (path === '~' || path.startsWith('~/'))
        path = GLib.get_home_dir() + path.slice(1);
    return path;
}

export function screenshotsDir(settings) {
    const custom = settings.get_string('folder').trim();
    if (custom)
        return expandHome(custom);
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ||
        GLib.get_home_dir();
    return GLib.build_filenamev([pictures, 'Screenshots']);
}

export function recordingsDir(settings) {
    const custom = settings.get_string('recording-folder').trim();
    return custom ? expandHome(custom) : screenshotsDir(settings);
}

/**
 * Picks the pattern for a capture and fills it in. %i counts up only when a
 * name actually used it.
 *
 * @param {Gio.Settings} settings - the extension settings
 * @param {object} info - see expand(); info.process set means the app is known
 * @returns {{folder: string, name: string}} folder relative to the root
 */
export function names(settings, info) {
    const appKnown = Boolean(info.process);
    const pattern = settings.get_string(appKnown ? 'name-pattern-app' : 'name-pattern') ||
        '%ra{10}';
    const subfolder = settings.get_string('subfolder');
    const usesCounter = /%i(?![a-z])/.test(pattern + subfolder);
    if (usesCounter) {
        info = {...info, counter: settings.get_int('counter')};
        settings.set_int('counter', info.counter + 1);
    }

    const folder = expand(subfolder, info).split('/').map(part => part.trim())
        .filter(part => part && part !== '.' && part !== '..').join('/');
    let name = expand(pattern, info).replace(/^\.+/, '');
    if (!name)
        name = random(ALNUM, 10);
    return {folder, name};
}

/**
 * Creates a new, empty file for a capture, making folders as needed. If the
 * name is taken, tries the pattern again (new random part), then adds -1, -2.
 *
 * @param {Gio.Settings} settings - the extension settings
 * @param {string} root - screenshotsDir() or recordingsDir()
 * @param {string} ext - file extension without the dot
 * @param {object} info - see expand()
 * @returns {Gio.File}
 */
export function createFile(settings, root, ext, info) {
    let {folder, name} = names(settings, info);
    const dir = Gio.File.new_for_path(GLib.build_filenamev([root, folder]));
    try {
        dir.make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }

    for (let attempt = 0; ; attempt++) {
        if (attempt > 0 && attempt < 5)
            ({name} = names(settings, info));
        const suffix = attempt >= 5 ? `-${attempt - 4}` : '';
        const file = dir.get_child(`${name}${suffix}.${ext}`);
        try {
            file.create(Gio.FileCreateFlags.NONE, null).close(null);
            return file;
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS) || attempt > 1000)
                throw e;
        }
    }
}

// "Screenshot From 2026-10-17 20-05-59", "Screencast From ...",
// Windows "Screenshot 2024-04-26 142737"
const NAME_DATE_RE = /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:.]?(\d{2})[-:.]?(\d{2})/;

function fileDate(info) {
    const m = NAME_DATE_RE.exec(info.get_name());
    if (m) {
        const date = GLib.DateTime.new_local(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
        if (date)
            return date;
    }
    return info.get_modification_date_time()?.to_local() ?? GLib.DateTime.new_now_local();
}

function tidyLogFile() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_state_dir(), 'screenshot-plus', 'last-tidy.json']));
}

// Screenshots and recordings sitting loose in the top of the capture folders.
export function findLoose(settings) {
    const roots = [...new Set([screenshotsDir(settings), recordingsDir(settings)])];
    const loose = [];
    for (const root of roots) {
        let children;
        try {
            children = Gio.File.new_for_path(root).enumerate_children(
                'standard::name,standard::type,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            continue;
        }
        for (const info of children) {
            const ext = info.get_name().split('.').pop().toLowerCase();
            if (info.get_file_type() === Gio.FileType.REGULAR &&
                [...IMAGE_TYPES, ...VIDEO_TYPES].includes(ext))
                loose.push({root, info, ext: ext === 'jpeg' ? 'jpg' : ext});
        }
        children.close(null);
    }
    return loose;
}

/**
 * Moves loose screenshots and recordings into their subfolders, renamed with
 * the name pattern and dated by their old name or modification time. Writes
 * an undo list.
 *
 * @param {Gio.Settings} settings - the extension settings
 * @returns {{moved: number, failed: string[]}}
 */
export function tidyUp(settings) {
    const moves = [];
    const failed = [];
    for (const {root, info, ext} of findLoose(settings)) {
        const source = Gio.File.new_for_path(GLib.build_filenamev([root, info.get_name()]));
        try {
            const target = createFile(settings, root, ext, {date: fileDate(info)});
            source.move(target, Gio.FileCopyFlags.OVERWRITE | Gio.FileCopyFlags.NOFOLLOW_SYMLINKS,
                null, null);
            moves.push([source.get_path(), target.get_path()]);
        } catch (e) {
            failed.push(`${info.get_name()}: ${e.message}`);
        }
    }

    if (moves.length) {
        const log = tidyLogFile();
        try {
            log.get_parent().make_directory_with_parents(null);
        } catch {}
        log.replace_contents(new TextEncoder().encode(JSON.stringify(moves, null, 1)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
    return {moved: moves.length, failed};
}

export function canUndoTidy() {
    return tidyLogFile().query_exists(null);
}

/**
 * Puts files from the last tidyUp() back where they were.
 *
 * @returns {{moved: number, failed: string[]}}
 */
export function undoTidy() {
    const log = tidyLogFile();
    const [, contents] = log.load_contents(null);
    const moves = JSON.parse(new TextDecoder().decode(contents));
    const failed = [];
    let moved = 0;
    for (const [from, to] of moves) {
        const file = Gio.File.new_for_path(to);
        try {
            file.move(Gio.File.new_for_path(from), Gio.FileCopyFlags.NOFOLLOW_SYMLINKS, null, null);
            moved++;
        } catch (e) {
            failed.push(`${GLib.path_get_basename(to)}: ${e.message}`);
        }
        // Remove folders the sort made, once empty (delete fails otherwise).
        for (let dir = file.get_parent(); dir && !dir.equal(Gio.File.new_for_path(from).get_parent());
            dir = dir.get_parent()) {
            try {
                dir.delete(null);
            } catch {
                break;
            }
        }
    }
    log.delete(null);
    return {moved, failed};
}
