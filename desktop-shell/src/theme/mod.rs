//! Native theme engine: turns the ten `ThemeSpec` recipes into a live egui surface.
//!
//! Responsibilities:
//! * hold the current interpolated spec and run the 700 ms theme cross-fade
//! * drive the background stack (gradient / blobs / fog) on egui's background layer
//! * schedule repaints honestly — a themed frame never spins when nothing animates
//! * provide the themed global `egui::Style` and the glass-card helpers pages build with
//!
//! The runtime lives in a thread-local because egui runs on one thread and the dozens of
//! page call sites read tokens through free functions (`crate::native_ui::native_palette`).

/// Debug-only screenshot QA driver for the theme acceptance pass (release builds exclude it).
#[cfg(debug_assertions)]
pub mod qa;
pub mod motion;
pub mod painter;
pub mod spec;
pub mod themes;

use std::cell::RefCell;
use std::time::{Duration, Instant};

use eframe::egui::{self, CornerRadius, Frame, Margin, Response, Shape, Ui};

use crate::ui_prefs::ThemePreference;

pub use self::motion::{MotionBudget, ReduceMotion};
use self::motion::Timed;
use self::spec::{Tokens, ThemeSpec};

/// How long after the last user input the ambient blob drift keeps running. Motion is a
/// greeting, not a space heater: once the window is idle the background freezes and the
/// engine stops requesting repaints entirely.
const DRIFT_IDLE_WINDOW: Duration = Duration::from_secs(45);

/// Outcome of `begin_frame`, consumed by the shell to decide on style / repaint work.
#[derive(Clone, Copy, Debug)]
pub struct FrameOutcome {
    /// The interpolated spec changed enough that the global style must be re-applied.
    pub spec_changed: bool,
    /// True while a theme cross-fade or ripple is in flight.
    pub transitioning: bool,
    /// True while blobs are drifting.
    pub drifting: bool,
}

struct Runtime {
    initialized: bool,
    target: &'static ThemeSpec,
    /// Snapshot the current cross-fade departs from (equals `spec` when settled).
    from: ThemeSpec,
    transition: Timed,
    ripple: Timed,
    spec: ThemeSpec,
    last_applied: Option<ThemeSpec>,
    page_enter: Timed,
    /// Drift phase in radians, advanced by wall-clock time while drifting.
    drift_phase: f32,
    drift_last: Option<Instant>,
    last_input: Instant,
    reduce_motion: ReduceMotion,
    system_reduce_motion: bool,
    budget: MotionBudget,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            initialized: false,
            target: themes::spec_for(ThemePreference::Soda, false),
            from: *themes::spec_for(ThemePreference::Soda, false),
            transition: Timed::idle(),
            ripple: Timed::idle(),
            spec: *themes::spec_for(ThemePreference::Soda, false),
            last_applied: None,
            page_enter: Timed::idle(),
            drift_phase: 0.0,
            drift_last: None,
            last_input: Instant::now(),
            reduce_motion: ReduceMotion::Auto,
            system_reduce_motion: false,
            budget: MotionBudget::full(),
        }
    }
}

thread_local! {
    static RUNTIME: RefCell<Runtime> = RefCell::new(Runtime::default());
}

/// Advance the engine for one frame. Returns what the shell must do about styling.
///
/// `system_dark` resolves `ThemePreference::System`; `system_reduce_motion` is the OS
/// “show animations” flag inverted (true = animations disabled).
pub fn begin_frame_at(
    ctx: &egui::Context,
    now: Instant,
    preference: ThemePreference,
    system_dark: bool,
    reduce_motion: ReduceMotion,
    system_reduce_motion: bool,
) -> FrameOutcome {
    RUNTIME.with(|runtime| {
        let mut runtime = runtime.borrow_mut();
        runtime.reduce_motion = reduce_motion;
        runtime.system_reduce_motion = system_reduce_motion;
        runtime.budget = if reduce_motion.resolve(system_reduce_motion) {
            MotionBudget::reduced()
        } else {
            MotionBudget::full()
        };

        let target = themes::spec_for(preference, system_dark);
        if !runtime.initialized {
            runtime.initialized = true;
            runtime.target = target;
            runtime.from = spec_of(target);
            runtime.spec = spec_of(target);
            runtime.last_applied = None;
        } else if !std::ptr::eq(runtime.target, target) {
            // Theme switch: snapshot the currently displayed spec (mid-transition switches
            // blend from the interpolated state, never from a stale endpoint).
            runtime.from = runtime.spec;
            runtime.target = target;
            let transition_ms = runtime
                .budget
                .theme_transition_ms(target.motion.theme_transition_ms);
            runtime.transition.start(now, transition_ms);
            if runtime.budget.ripple_enabled() {
                runtime.ripple.start(now, target.motion.ripple_ms);
            } else {
                runtime.ripple.finish();
            }
        }

        let progress = runtime.transition.sample(now);
        runtime.spec = if runtime.transition.is_active() {
            // `sample` above already cleared a finished animation, so re-check activity.
            ThemeSpec::lerp(&runtime.from, runtime.target, motion::cross_fade(progress))
        } else {
            // A finished transition snaps exactly to the target recipe.
            spec_of(runtime.target)
        };

        runtime.ripple.sample(now);

        // Page enter: a new page fades and rises once.
        runtime.page_enter.sample(now);

        // Input tracking → drift window.
        let had_input = ctx.input(|input| !input.events.is_empty() || input.pointer.any_down());
        if had_input {
            runtime.last_input = now;
        }
        let focused = ctx.input(|input| input.focused);
        let drifting = runtime.budget.drift_enabled()
            && focused
            && now.saturating_duration_since(runtime.last_input) < DRIFT_IDLE_WINDOW;
        if drifting {
            let dt = runtime
                .drift_last
                .map(|last| now.saturating_duration_since(last).as_secs_f32())
                .unwrap_or(0.0)
                .min(0.25);
            let period = runtime.spec.motion.drift_period_ms.max(1) as f32 / 1_000.0;
            runtime.drift_phase += dt / period * std::f32::consts::TAU;
            if runtime.drift_phase > std::f32::consts::TAU {
                runtime.drift_phase -= std::f32::consts::TAU;
            }
        }
        runtime.drift_last = Some(now);

        // Repaint budget: 30 fps while anything moves, nothing extra when settled.
        let transitioning = runtime.transition.is_active() || runtime.ripple.is_active();
        if transitioning {
            ctx.request_repaint_after(Duration::from_millis(16));
        } else if drifting {
            let fps = runtime.spec.motion.drift_fps.clamp(15, 60);
            ctx.request_repaint_after(Duration::from_millis(u64::from(1_000 / fps)));
        }

        let spec_changed = match runtime.last_applied {
            Some(applied) => applied != runtime.spec,
            None => true,
        };
        if spec_changed {
            runtime.last_applied = Some(runtime.spec);
        }
        FrameOutcome {
            spec_changed,
            transitioning,
            drifting,
        }
    })
}

/// Whether the OS reports animations as disabled (“Show animations in Windows” off).
/// Queried once per process; the tray UI re-reads it on restart, matching DSH semantics.
pub fn system_reduce_motion() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(query_system_reduce_motion)
}

#[cfg(windows)]
fn query_system_reduce_motion() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::SystemParametersInfoW;
    const SPI_GETCLIENTAREAANIMATION: u32 = 0x1042;
    let mut animations_on: i32 = 1;
    // SAFETY: documented query interface; we pass a valid out-pointer for BOOL and zero
    // flags, and only read the value when the call reports success.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut animations_on as *mut i32).cast(),
            0,
        )
    };
    ok != 0 && animations_on == 0
}

#[cfg(not(windows))]
fn query_system_reduce_motion() -> bool {
    false
}

/// Wall-clock wrapper used by the shell.
pub fn begin_frame(
    ctx: &egui::Context,
    preference: ThemePreference,
    system_dark: bool,
    reduce_motion: ReduceMotion,
    system_reduce_motion: bool,
) -> FrameOutcome {
    begin_frame_at(
        ctx,
        Instant::now(),
        preference,
        system_dark,
        reduce_motion,
        system_reduce_motion,
    )
}

fn spec_of(spec: &'static ThemeSpec) -> ThemeSpec {
    *spec
}

/// The interpolated spec of the current frame.
pub fn current() -> ThemeSpec {
    RUNTIME.with(|runtime| runtime.borrow().spec)
}

/// The interpolated tokens of the current frame.
pub fn tokens() -> Tokens {
    current().tokens
}

/// Paint the background stack + ripple on egui's background layer for this frame.
pub fn paint_background(ctx: &egui::Context) {
    let (spec, from, ripple, drifting) = RUNTIME.with(|runtime| {
        let runtime = runtime.borrow();
        (
            runtime.spec,
            runtime.from,
            runtime.ripple.is_active(),
            runtime.budget.drift_enabled(),
        )
    });
    let painter = ctx.layer_painter(egui::LayerId::background());
    let rect = ctx.viewport_rect();
    let drift = if drifting { Some(RUNTIME.with(|r| r.borrow().drift_phase)) } else { None };
    painter::paint_background(&painter, ctx, rect, &spec, drift);
    if ripple {
        let t = RUNTIME.with(|r| r.borrow().ripple.progress(Instant::now()));
        painter::paint_ripple(&painter, rect, &from, &spec, t, spec.motion.ripple_rings);
    }
}

/// Begin a page-enter animation (fade + rise). Called when the shell changes pages.
pub fn begin_page_enter() {
    RUNTIME.with(|runtime| {
        let mut runtime = runtime.borrow_mut();
        let ms = runtime.budget.page_enter_ms(runtime.spec.motion.page_enter_ms);
        runtime.page_enter.start(Instant::now(), ms);
    });
}

/// Current page-enter progress: `(alpha, rise_px)`. Idle pages report fully visible.
pub fn page_enter_state() -> (f32, f32) {
    RUNTIME.with(|runtime| {
        let mut runtime = runtime.borrow_mut();
        let budget = runtime.budget;
        let rise = budget.page_enter_rise();
        let progress = runtime.page_enter.sample(Instant::now());
        if progress >= 1.0 {
            (1.0, 0.0)
        } else {
            (progress.max(0.02), rise * (1.0 - motion::enter_ease(progress)))
        }
    })
}

/// Whether a theme transition or ripple is currently animating (for tests / diagnostics).
pub fn is_transitioning() -> bool {
    RUNTIME.with(|runtime| {
        let runtime = runtime.borrow();
        runtime.transition.is_active() || runtime.ripple.is_active()
    })
}

/// The themed global `egui::Style` for a spec. Radii, fills and strokes all come from the
/// tokens so no page keeps a hard-coded gray.
pub fn style(spec: &ThemeSpec) -> egui::Style {
    let tokens = spec.tokens;
    let dark = spec.dark;
    let mut style = egui::Style::default();
    style.spacing.item_spacing = egui::vec2(12.0, 10.0);
    style.spacing.window_margin = Margin::symmetric(18, 16);
    style.spacing.button_padding = egui::vec2(10.0, 6.0);
    style.spacing.menu_margin = Margin::same(8);
    style.spacing.interact_size = egui::vec2(40.0, 32.0);
    style.spacing.combo_width = 260.0;
    style.spacing.text_edit_width = 320.0;
    style.spacing.extra_text_line_spacing = 2.0;

    style
        .text_styles
        .insert(egui::TextStyle::Heading, egui::FontId::proportional(26.0));
    style
        .text_styles
        .insert(egui::TextStyle::Body, egui::FontId::proportional(15.0));
    style
        .text_styles
        .insert(egui::TextStyle::Button, egui::FontId::proportional(14.0));
    style
        .text_styles
        .insert(egui::TextStyle::Small, egui::FontId::proportional(13.0));
    style
        .text_styles
        .insert(egui::TextStyle::Monospace, egui::FontId::monospace(13.0));

    let mut visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };
    visuals.dark_mode = dark;
    visuals.override_text_color = Some(tokens.text.to_color32());
    visuals.weak_text_color = Some(tokens.text_2.to_color32());
    // Panels are transparent: the painted background layer shows through, exactly like the
    // Web `.bg-decor` fixed canvas. Individual surfaces (cards, wells) carry the glass.
    visuals.panel_fill = egui::Color32::TRANSPARENT;
    visuals.window_fill = tokens.panel_solid.to_color32();
    visuals.window_stroke = egui::Stroke::new(1.0, tokens.border.to_color32());
    visuals.window_corner_radius = CornerRadius::same(spec.radius_s.round() as u8);
    visuals.faint_bg_color = tokens.bg_soft.to_color32();
    visuals.extreme_bg_color = tokens.input_bg.over(tokens.bg).to_color32();
    visuals.text_edit_bg_color = Some(tokens.input_bg.over(tokens.bg).to_color32());
    visuals.code_bg_color = tokens.chip.over(tokens.bg).to_color32();
    visuals.hyperlink_color = tokens.accent.to_color32();
    visuals.warn_fg_color = tokens.warn.to_color32();
    visuals.error_fg_color = tokens.err.to_color32();
    visuals.selection = egui::style::Selection {
        bg_fill: tokens.accent_soft.over(tokens.bg).to_color32(),
        stroke: egui::Stroke::new(1.0, tokens.accent.to_color32()),
    };
    // Focus must stay obvious in every theme (task acceptance: clear focus state).
    visuals.widgets.active.bg_stroke = egui::Stroke::new(1.5, tokens.accent.to_color32());
    visuals.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, tokens.accent_soft.to_color32());

    let widget_radius = CornerRadius::same(spec.radius_s.round().clamp(2.0, 255.0) as u8);
    let visual = |fill: egui::Color32, weak: egui::Color32, text: egui::Color32, stroke: egui::Stroke| {
        egui::style::WidgetVisuals {
            bg_fill: fill,
            weak_bg_fill: weak,
            bg_stroke: stroke,
            corner_radius: widget_radius,
            fg_stroke: egui::Stroke::new(1.0, text),
            expansion: 0.0,
        }
    };
    let border = egui::Stroke::new(1.0, tokens.border.to_color32());
    let soft_border = egui::Stroke::new(1.0, tokens.border_soft.to_color32());
    // Widget fills use the *composited* well colours: egui widgets are flat, the inset
    // light/dark depth comes from `paint_well` where pages draw their own chrome.
    visuals.widgets.noninteractive = visual(
        tokens.panel.over(tokens.bg).to_color32(),
        tokens.panel.over(tokens.bg).to_color32(),
        tokens.text.to_color32(),
        border,
    );
    visuals.widgets.inactive = visual(
        tokens.chip.over(tokens.bg).to_color32(),
        tokens.panel.over(tokens.bg).to_color32(),
        tokens.text_2.to_color32(),
        soft_border,
    );
    visuals.widgets.hovered = visual(
        tokens.hover.over(tokens.bg).to_color32(),
        tokens.chip.over(tokens.bg).to_color32(),
        tokens.text.to_color32(),
        egui::Stroke::new(1.0, tokens.accent_soft.scale_alpha(2.0).to_color32()),
    );
    visuals.widgets.active = visual(
        tokens.accent_soft.over(tokens.bg).to_color32(),
        tokens.accent_soft.over(tokens.bg).to_color32(),
        tokens.text.to_color32(),
        egui::Stroke::new(1.5, tokens.accent.to_color32()),
    );
    visuals.widgets.open = visuals.widgets.active;
    // Gummy elevation for the floating layers (menus, tooltips, windows).
    let menu_shadow = egui::epaint::Shadow {
        offset: [0, 10],
        blur: 28,
        spread: 0,
        color: tokens.shadow_c1.scale_alpha(0.9).to_color32(),
    };
    visuals.window_shadow = menu_shadow;
    visuals.popup_shadow = menu_shadow;
    visuals.button_frame = true;
    visuals.collapsing_header_frame = true;
    visuals.striped = true;
    visuals.disabled_alpha = 0.55;
    style.visuals = visuals;
    style.animation_time = if RUNTIME.with(|runtime| runtime.borrow().budget.reduce_motion) {
        0.05
    } else {
        0.18
    };
    style
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/// Ink margin of a glass card (`article.card` paddings, 16–18 px).
pub const CARD_MARGIN: Margin = Margin {
    left: 18,
    right: 18,
    top: 16,
    bottom: 16,
};

/// A gummy glass card: shadow + fill + border + rim are painted behind `add`'s content.
pub fn card<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> egui::InnerResponse<R> {
    let spec = current();
    let painter = ui.painter().clone();
    let slot = painter.add(Shape::Noop);
    let frame = Frame::new().inner_margin(CARD_MARGIN);
    let response = frame.show(ui, add);
    let rect = response.response.rect;
    if ui.is_rect_visible(rect) {
        painter.set(slot, Shape::Vec(painter::card_shapes(rect, &spec)));
    }
    response
}

/// Compact card used for dense rows (smaller margins, same material).
pub fn card_compact<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> egui::InnerResponse<R> {
    card_compact_with(ui, None, add)
}

/// Compact card with an optional accent border (warning / error row states keep the card
/// material but signal attention through the stroke).
pub fn card_compact_with<R>(
    ui: &mut Ui,
    accent: Option<egui::Color32>,
    add: impl FnOnce(&mut Ui) -> R,
) -> egui::InnerResponse<R> {
    let spec = current();
    let painter = ui.painter().clone();
    let slot = painter.add(Shape::Noop);
    let frame = Frame::new().inner_margin(Margin {
        left: 14,
        right: 14,
        top: 11,
        bottom: 11,
    });
    let response = frame.show(ui, add);
    let rect = response.response.rect;
    if ui.is_rect_visible(rect) {
        let mut shapes = painter::card_shapes(rect, &spec);
        if let Some(accent) = accent {
            shapes.push(Shape::rect_stroke(
                rect,
                CornerRadius::same(spec.radius_s.round().clamp(0.0, 255.0) as u8),
                egui::Stroke::new(1.5, accent),
                egui::StrokeKind::Inside,
            ));
        }
        painter.set(slot, Shape::Vec(shapes));
    }
    response
}

/// Paint a gummy button at its natural rect with animated hover/press. Returns the response.
pub fn gummy_button(
    ui: &mut Ui,
    text: &str,
    kind: painter::ButtonKind,
    enabled: bool,
) -> Response {
    let spec = current();
    let tokens = spec.tokens;
    let font = egui::TextStyle::Button.resolve(ui.style());
    let galley = ui
        .painter()
        .layout_no_wrap(text.to_owned(), font, tokens.text.to_color32());
    let size = egui::vec2(galley.size().x + 30.0, galley.size().y.max(20.0) + 14.0);
    let sense = if enabled {
        egui::Sense::click()
    } else {
        egui::Sense::hover()
    };
    let (rect, response) = ui.allocate_exact_size(size, sense);
    if ui.is_rect_visible(rect) {
        // 0.18 s hover / 0.08 s press — the Web transition durations.
        let hover_t = ui
            .ctx()
            .animate_bool_with_time(response.id.with("hover"), enabled && response.hovered(), 0.18);
        let press_t = ui.ctx().animate_bool_with_time(
            response.id.with("press"),
            enabled && response.is_pointer_button_down_on(),
            0.08,
        );
        painter::paint_button(
            ui.painter(),
            rect,
            spec.radius_s,
            &spec,
            kind,
            hover_t,
            press_t,
            enabled,
        );
        let text_color = match kind {
            painter::ButtonKind::Primary
            | painter::ButtonKind::Danger
            | painter::ButtonKind::Armed => tokens.on_accent,
            _ => tokens.text,
        };
        let text_color = if enabled {
            text_color
        } else {
            text_color.with_alpha(0.55)
        };
        let galley = ui.painter().layout_no_wrap(
            text.to_owned(),
            egui::TextStyle::Button.resolve(ui.style()),
            text_color.to_color32(),
        );
        let sink = press_t * 2.0;
        ui.painter().galley(
            rect.center() - galley.size() / 2.0 + egui::vec2(0.0, sink),
            galley,
            text_color.to_color32(),
        );
    }
    response
}

/// Inset neumorphic well (input / dropdown trigger background) with the content drawn on
/// top: reserves a slot, lays out `add` inside, then paints the inset shadows behind it.
pub fn well<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> egui::InnerResponse<R> {
    let spec = current();
    let painter = ui.painter().clone();
    let slot = painter.add(Shape::Noop);
    let frame = Frame::new().inner_margin(Margin::symmetric(10, 6));
    let response = frame.show(ui, add);
    let rect = response.response.rect;
    if ui.is_rect_visible(rect) {
        let corner = CornerRadius::same(spec.radius_s.round().clamp(0.0, 255.0) as u8);
        let mut shapes = vec![Shape::rect_filled(
            rect,
            corner,
            spec.tokens.input_bg.over(spec.tokens.bg).to_color32(),
        )];
        shapes.extend(painter::well_inset_shapes(rect, spec.radius_s, &spec));
        painter.set(slot, Shape::Vec(shapes));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_frame(
        ctx: &egui::Context,
        now: Instant,
        preference: ThemePreference,
        reduce: ReduceMotion,
    ) -> FrameOutcome {
        let mut outcome = None;
        let output = ctx.run_ui(egui::RawInput::default(), |ctx| {
            outcome = Some(begin_frame_at(ctx, now, preference, false, reduce, false));
        });
        output.drop_without_applying_deltas();
        outcome.expect("frame ran")
    }

    #[test]
    fn theme_switch_interpolates_and_settles_to_the_target() {
        let ctx = egui::Context::default();
        let t0 = Instant::now();
        run_frame(&ctx, t0, ThemePreference::Soda, ReduceMotion::Off);
        let soda = current();
        assert_eq!(soda.id, "soda");
        // Switch begins at t0+100 ms; the frame it starts on still shows the old spec.
        run_frame(&ctx, t0 + Duration::from_millis(100), ThemePreference::Ink, ReduceMotion::Off);
        // Half-way (350 ms into a 700 ms fade) the spec must differ from both endpoints.
        let mid = run_frame(&ctx, t0 + Duration::from_millis(450), ThemePreference::Ink, ReduceMotion::Off);
        assert!(mid.transitioning, "mid-transition frame reports animating");
        let interpolated = current();
        let ink = themes::by_id("ink").expect("ink");
        assert_ne!(interpolated.radius, soda.radius);
        assert!(interpolated.radius > ink.radius);
        assert!(interpolated.tokens.text.is_finite());
        // After the transition window the spec is exactly the target.
        run_frame(&ctx, t0 + Duration::from_millis(1_600), ThemePreference::Ink, ReduceMotion::Off);
        let settled = current();
        assert_eq!(settled.id, "ink");
        assert!((settled.radius - ink.radius).abs() < 1e-4);
        assert!(!is_transitioning(), "transition must end");
    }

    #[test]
    fn reduce_motion_shortens_the_transition_and_skips_the_ripple() {
        let ctx = egui::Context::default();
        let t0 = Instant::now();
        run_frame(&ctx, t0, ThemePreference::Soda, ReduceMotion::On);
        let outcome = run_frame(
            &ctx,
            t0 + Duration::from_millis(20),
            ThemePreference::Dusk,
            ReduceMotion::On,
        );
        assert!(outcome.transitioning);
        run_frame(&ctx, t0 + Duration::from_millis(400), ThemePreference::Dusk, ReduceMotion::On);
        assert_eq!(current().id, "dusk", "150 ms reduced fade must have settled");
        assert!(!RUNTIME.with(|runtime| runtime.borrow().ripple.is_active()));
    }

    #[test]
    fn system_preference_resolves_through_the_engine() {
        let ctx = egui::Context::default();
        let t0 = Instant::now();
        let mut outcome = None;
        let output = ctx.run_ui(egui::RawInput::default(), |ctx| {
            outcome = Some(begin_frame_at(
                ctx,
                t0,
                ThemePreference::System,
                true,
                ReduceMotion::Off,
                false,
            ));
        });
        output.drop_without_applying_deltas();
        assert!(outcome.expect("frame").spec_changed);
        assert_eq!(current().id, "deep");
    }

    #[test]
    fn style_has_no_transparent_panel_and_keeps_a_visible_focus_ring() {
        for spec in themes::all() {
            let style = style(spec);
            assert_eq!(style.visuals.panel_fill, egui::Color32::TRANSPARENT);
            assert!(style.visuals.widgets.active.bg_stroke.width >= 1.5);
            assert_eq!(
                style.visuals.override_text_color,
                Some(spec.tokens.text.to_color32())
            );
        }
    }
}
