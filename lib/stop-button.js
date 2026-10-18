// A floating stop button for recordings that shows on screen but not in them.
//
// Mutter takes a monitor or area screen-cast frame either while the stage
// paints a view (stage watches, inside ClutterStage's own paint-view handler)
// or with a separate paint of the stage. This draws the button with Cogl in a
// paint-view handler connected *after* that one, straight into the view's
// framebuffer, so it reaches the screen but no recording. A monitor stream
// copies the whole framebuffer, though, and parts not repainted in a frame
// keep last frame's pixels; so the button's square is queued for repainting
// every frame, and the stage has painted over it before Mutter copies. A
// transparent, reactive St.Button in the same place takes the click.

import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SIZE = 48; // logical pixels
const MARGIN = 20; // from the recorded area's edge

// Round dark button with a red rounded square, anti-aliased, premultiplied.
// p is -1..1 across the button; px is one physical pixel in that unit.
const BUTTON_SHADER = (px, hover) => `
    vec2 p = cogl_tex_coord0_in.st * 2.0 - 1.0;
    float px = ${px.toFixed(6)};
    float d = length(p);
    float disc = clamp((1.0 - d) / px + 0.5, 0.0, 1.0);
    float ring = disc * clamp((d - (1.0 - 2.0 * px)) / px + 0.5, 0.0, 1.0);
    vec2 q = abs(p) - vec2(0.30);
    float box = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.08;
    float stop = clamp(-box / px + 0.5, 0.0, 1.0);
    vec3 rgb = mix(vec3(${hover ? '0.22' : '0.12'}), vec3(1.0), ring * 0.8);
    rgb = mix(rgb, vec3(${hover ? '1.0, 0.32, 0.32' : '0.90, 0.16, 0.16'}), stop);
    float a = disc * 0.9;
    cogl_color_out = vec4(rgb * a, a);`;

export class StopButton {
    /**
     * @param {number[]} area - x, y, width, height of the recording, in stage coordinates
     * @param {Function} onClick - called when the button is clicked
     */
    constructor(area, onClick) {
        this._button = new St.Button({
            reactive: true,
            can_focus: false,
            track_hover: true,
            style: 'background: none; border: none; box-shadow: none; padding: 0;',
            width: SIZE,
            height: SIZE,
            accessible_name: 'Stop recording',
        });
        this._button.connect('clicked', () => onClick());
        this._button.connect('notify::hover', () => this._button.queue_redraw());
        Main.layoutManager.addTopChrome(this._button);
        this._place(area);

        this._pipelines = new Map();
        this._paintId = global.stage.connect_after('paint-view',
            (stage, view) => this._paintView(stage, view));
        this._afterPaintId = global.stage.connect('after-paint', () => this._button.queue_redraw());
        // A fullscreen window scanned out directly skips the stage paint.
        global.compositor.disable_unredirect();
        global.stage.queue_redraw();
    }

    // Just outside the area's bottom-right corner (below, right of or above
    // it) when the monitor has room; else inside it (whole-screen recordings).
    _place([x, y, width, height]) {
        const index = global.display.get_monitor_index_for_rect(new Mtk.Rectangle({x, y, width, height}));
        const m = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        const gap = MARGIN / 2;
        const fits = ([bx, by]) => bx >= m.x && by >= m.y &&
            bx + SIZE <= m.x + m.width && by + SIZE <= m.y + m.height;
        const [bx, by] = [
            [x + width - SIZE, y + height + gap],
            [x + width + gap, y + height - SIZE],
            [x + width - SIZE, y - gap - SIZE],
        ].find(fits) ?? [
            Math.max(m.x, Math.min(x + width, m.x + m.width) - SIZE - MARGIN),
            Math.max(m.y, Math.min(y + height, m.y + m.height) - SIZE - MARGIN),
        ];
        this._button.set_position(Math.round(bx), Math.round(by));
    }

    _pipeline(view, scale, hover) {
        const key = `${scale}/${hover}`;
        let byView = this._pipelines.get(view);
        if (!byView)
            this._pipelines.set(view, byView = new Map());
        let pipeline = byView.get(key);
        if (!pipeline) {
            const cogl = global.stage.context.get_backend().get_cogl_context();
            pipeline = Cogl.Pipeline.new(cogl);
            pipeline.set_layer_null_texture(0);
            // Cogl blends only pipelines it thinks are translucent, and it
            // doesn't look into snippets; the shader ignores this colour.
            pipeline.set_color(new Cogl.Color({red: 128, green: 128, blue: 128, alpha: 128}));
            pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, null,
                BUTTON_SHADER(2 / (SIZE * scale), hover)));
            // The shader's colours are sRGB like the rest of the UI; the view
            // may be in another colour state (e.g. HDR).
            try {
                global.stage.color_state.add_pipeline_transform(view.color_state, pipeline, 0);
            } catch {}
            byView.set(key, pipeline);
        }
        return pipeline;
    }

    _paintView(stage, view) {
        const [x, y] = this._button.get_transformed_position();
        const [w, h] = this._button.get_transformed_size();
        const layout = new Mtk.Rectangle();
        view.get_layout(layout);
        if (x >= layout.x + layout.width || y >= layout.y + layout.height ||
            x + w <= layout.x || y + h <= layout.y)
            return;

        // Clutter's viewport spans the whole stage, so stage coordinates map
        // straight to normalized device coordinates.
        const framebuffer = view.get_framebuffer();
        const [sw, sh] = [stage.width, stage.height];
        const projection = framebuffer.get_projection_matrix();
        const identity = new Graphene.Matrix().init_identity();
        framebuffer.push_matrix();
        framebuffer.set_modelview_matrix(identity);
        framebuffer.set_projection_matrix(identity);
        framebuffer.draw_textured_rectangle(this._pipeline(view, view.get_scale(), this._button.hover),
            2 * x / sw - 1, 1 - 2 * y / sh, 2 * (x + w) / sw - 1, 1 - 2 * (y + h) / sh, 0, 0, 1, 1);
        framebuffer.set_projection_matrix(projection);
        framebuffer.pop_matrix();
    }

    destroy() {
        if (!this._button)
            return;
        global.stage.disconnect(this._paintId);
        global.stage.disconnect(this._afterPaintId);
        global.compositor.enable_unredirect();
        Main.layoutManager.removeChrome(this._button);
        this._button.destroy();
        this._button = null;
        this._pipelines.clear();
        global.stage.queue_redraw();
    }
}
