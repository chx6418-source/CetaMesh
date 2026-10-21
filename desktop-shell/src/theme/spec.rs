//! Theme specification: the full visual recipe for one CetaMesh theme.
//!
//! Fact source: UI v1 的唯一主题是「纸面工作台」（方案 01），配方见 `themes.rs` 的
//! `PAPER`（探索稿 `design-demos/ui-ia-exploration-2026-10/p01.html` 的 token 转写）。
//! 数据模型沿用自最早的苏打糖设计系统（`design-demos/CetaMesh-ten-themes`），Every
//! field here mirrors a CSS custom property or a `.bg-decor` / `article.card` / `.btn` /
//! `input` recipe from that file, so the native shell can reproduce the Web look with
//! egui shapes only — no WebView and no HTML.
//!
//! Colours are kept as straight-alpha `Rgba` (0..1 floats) instead of `Color32` because theme
//! switching interpolates every colour for 600–900 ms; premultiplied `Color32` cannot be lerped
//! correctly once alpha < 1.

use eframe::egui::Color32;

/// Contrast target for theme colours when they are used as *text* (headroom above WCAG AA's
/// 4.5:1 because the same tone also renders on tinted chips whose backdrop is slightly darker
/// or lighter than the plain card surface).
pub const TEXT_TARGET_CONTRAST: f32 = 5.5;

/// Contrast target for theme colours on tinted soft chips (`--accent-soft`, `--err-bg`).
pub const CHIP_TARGET_CONTRAST: f32 = 4.6;

/// Straight-alpha sRGB colour. `a == 1` means fully opaque.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const fn rgba(r: u8, g: u8, b: u8, a: f32) -> Self {
        Self {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a,
        }
    }

    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self::rgba(r, g, b, 1.0)
    }

    /// `0xRRGGBB` with an explicit alpha.
    pub const fn hex(hex: u32, a: f32) -> Self {
        Self::rgba((hex >> 16) as u8, (hex >> 8) as u8, hex as u8, a)
    }

    pub const fn with_alpha(self, a: f32) -> Self {
        Self { a, ..self }
    }

    pub const fn scale_alpha(self, factor: f32) -> Self {
        self.with_alpha(self.a * factor)
    }

    /// `filter: brightness(f)` in gamma space — RGB channels scale, alpha stays.
    pub const fn gamma_scale(self, factor: f32) -> Self {
        Self {
            r: (self.r * factor).clamp(0.0, 1.0),
            g: (self.g * factor).clamp(0.0, 1.0),
            b: (self.b * factor).clamp(0.0, 1.0),
            a: self.a,
        }
    }

    /// Straight-alpha linear interpolation, matching CSS colour transitions closely enough
    /// (CSS interpolates premultiplied; the difference only shows while fading translucent
    /// layers mid-transition, which is imperceptible against the animated background).
    pub fn lerp(self, other: Self, t: f32) -> Self {
        // Exact endpoints: a settled transition must land on the target recipe bit-for-bit
        // so equality checks and tests never trip on 1-ulp differences.
        if t <= 0.0 {
            return self;
        }
        if t >= 1.0 {
            return other;
        }
        Self {
            r: self.r + (other.r - self.r) * t,
            g: self.g + (other.g - self.g) * t,
            b: self.b + (other.b - self.b) * t,
            a: self.a + (other.a - self.a) * t,
        }
    }

    /// Move `factor` (0..=1) of the way toward another colour, alpha preserved.
    pub fn mix(self, other: Self, factor: f32) -> Self {
        Self {
            r: self.r + (other.r - self.r) * factor,
            g: self.g + (other.g - self.g) * factor,
            b: self.b + (other.b - self.b) * factor,
            a: self.a,
        }
    }

    /// Source-over compositing of a translucent colour onto an opaque backdrop.
    pub fn over(self, backdrop: Self) -> Self {
        let a = self.a + backdrop.a * (1.0 - self.a);
        if a <= f32::EPSILON {
            return Self { a: 0.0, ..self };
        }
        let mix = |fg: f32, bg: f32| (fg * self.a + bg * backdrop.a * (1.0 - self.a)) / a;
        Self {
            r: mix(self.r, backdrop.r),
            g: mix(self.g, backdrop.g),
            b: mix(self.b, backdrop.b),
            a,
        }
    }

    pub fn to_color32(self) -> Color32 {
        Color32::from_rgba_unmultiplied(
            (self.r.clamp(0.0, 1.0) * 255.0).round() as u8,
            (self.g.clamp(0.0, 1.0) * 255.0).round() as u8,
            (self.b.clamp(0.0, 1.0) * 255.0).round() as u8,
            (self.a.clamp(0.0, 1.0) * 255.0).round() as u8,
        )
    }

    pub fn is_finite(self) -> bool {
        self.r.is_finite() && self.g.is_finite() && self.b.is_finite() && self.a.is_finite()
    }
}

/// Quadratic falloff between two floats.
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

/// WCAG relative luminance of an opaque colour.
pub fn relative_luminance(color: Rgba) -> f32 {    fn channel(value: f32) -> f32 {
        let v = value.clamp(0.0, 1.0);
        if v <= 0.040_45 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/// WCAG contrast ratio (1.0 .. 21.0). Callers must composite translucent colours first.
pub fn contrast_ratio(a: Rgba, b: Rgba) -> f32 {
    let (la, lb) = (relative_luminance(a), relative_luminance(b));
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// One ambient light blob of the `.bg-decor::before` layer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Blob {
    /// Colour at the blob centre (alpha carries the CSS rgba alpha).
    pub color: Rgba,
    /// Centre as viewport fractions `(x / width, y / height)`.
    pub center: [f32; 2],
    /// Ellipse radii in viewport-width fractions (`44vw` → `0.44`), x and y.
    pub radius_vw: [f32; 2],
    /// Radius fraction where the colour reaches transparent (`transparent 62%` → `0.62`).
    pub fade: f32,
}

impl Blob {
    fn lerp(self, other: Self, t: f32) -> Self {
        Self {
            color: self.color.lerp(other.color, t),
            center: [
                lerp(self.center[0], other.center[0], t),
                lerp(self.center[1], other.center[1], t),
            ],
            radius_vw: [
                lerp(self.radius_vw[0], other.radius_vw[0], t),
                lerp(self.radius_vw[1], other.radius_vw[1], t),
            ],
            fade: lerp(self.fade, other.fade, t),
        }
    }
}

/// A blob slot: present with a colour, or absent（纸面主题隐藏 2/3 的光斑）
/// individual blobs or the whole layer). Absence is modelled as alpha 0 so a theme switch can
/// fade blobs in and out instead of popping.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BlobSlot(pub Blob);

impl BlobSlot {
    pub fn lerp(self, other: Self, t: f32) -> Self {
        Self(self.0.lerp(other.0, t))
    }

}

/// Top fog: `.bg-decor::after` — a large soft white radial clamped to the top edge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fog {
    pub color: Rgba,
    pub center: [f32; 2],
    pub radius_vw: f32,
    pub radius_vh: f32,
    pub fade: f32,
}

impl Fog {
    fn lerp(self, other: Self, t: f32) -> Self {
        Self {
            color: self.color.lerp(other.color, t),
            center: [
                lerp(self.center[0], other.center[0], t),
                lerp(self.center[1], other.center[1], t),
            ],
            radius_vw: lerp(self.radius_vw, other.radius_vw, t),
            radius_vh: lerp(self.radius_vh, other.radius_vh, t),
            fade: lerp(self.fade, other.fade, t),
        }
    }
}



/// The full background recipe: three-stop linear gradient + up to three ambient blobs + fog.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Background {
    /// Stops at CSS positions 0 % / 48 % / 100 % of the gradient axis.
    pub gradient: [Rgba; 3],
    /// CSS gradient angle in degrees (`linear-gradient(130deg, …)` → `130.0`).
    /// 0° points up, angles grow clockwise.
    pub gradient_angle: f32,
    pub blobs: [BlobSlot; 3],
    pub fog: Fog,
}

impl Background {
    fn lerp(self, other: Self, t: f32) -> Self {
        Self {
            gradient: [
                self.gradient[0].lerp(other.gradient[0], t),
                self.gradient[1].lerp(other.gradient[1], t),
                self.gradient[2].lerp(other.gradient[2], t),
            ],
            gradient_angle: lerp(self.gradient_angle, other.gradient_angle, t),
            blobs: [
                self.blobs[0].lerp(other.blobs[0], t),
                self.blobs[1].lerp(other.blobs[1], t),
                self.blobs[2].lerp(other.blobs[2], t),
            ],
            fog: self.fog.lerp(other.fog, t),
        }
    }

    /// Sample the three-stop gradient at `t` in `0..=1`.
    pub fn gradient_at(&self, t: f32) -> Rgba {
        let t = t.clamp(0.0, 1.0);
        if t <= 0.48 {
            self.gradient[0].lerp(self.gradient[1], t / 0.48)
        } else {
            self.gradient[1].lerp(self.gradient[2], (t - 0.48) / 0.52)
        }
    }
}

/// Named colours of the design system (`--text`, `--panel`, `--accent`, …).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tokens {
    pub bg: Rgba,
    pub bg_soft: Rgba,
    pub panel: Rgba,
    pub panel_solid: Rgba,
    pub glass_weak: Rgba,
    pub chip: Rgba,
    pub input_bg: Rgba,
    pub hover: Rgba,
    pub border: Rgba,
    pub border_soft: Rgba,
    pub edge_hi: Rgba,
    pub edge_lo: Rgba,
    pub text: Rgba,
    pub text_2: Rgba,
    pub text_3: Rgba,
    pub accent: Rgba,
    pub accent_2: Rgba,
    pub accent_soft: Rgba,
    pub accent_shadow: Rgba,
    pub on_accent: Rgba,
    pub shadow_c1: Rgba,
    pub shadow_c2: Rgba,
    pub ok: Rgba,
    pub ok_bg: Rgba,
    pub warn: Rgba,
    pub warn_2: Rgba,
    pub warn_bg: Rgba,
    pub warn_ink: Rgba,
    pub err: Rgba,
    pub err_2: Rgba,
    pub err_bg: Rgba,
}

impl Tokens {
    fn lerp(self, other: Self, t: f32) -> Self {
        Self {
            bg: self.bg.lerp(other.bg, t),
            bg_soft: self.bg_soft.lerp(other.bg_soft, t),
            panel: self.panel.lerp(other.panel, t),
            panel_solid: self.panel_solid.lerp(other.panel_solid, t),
            glass_weak: self.glass_weak.lerp(other.glass_weak, t),
            chip: self.chip.lerp(other.chip, t),
            input_bg: self.input_bg.lerp(other.input_bg, t),
            hover: self.hover.lerp(other.hover, t),
            border: self.border.lerp(other.border, t),
            border_soft: self.border_soft.lerp(other.border_soft, t),
            edge_hi: self.edge_hi.lerp(other.edge_hi, t),
            edge_lo: self.edge_lo.lerp(other.edge_lo, t),
            text: self.text.lerp(other.text, t),
            text_2: self.text_2.lerp(other.text_2, t),
            text_3: self.text_3.lerp(other.text_3, t),
            accent: self.accent.lerp(other.accent, t),
            accent_2: self.accent_2.lerp(other.accent_2, t),
            accent_soft: self.accent_soft.lerp(other.accent_soft, t),
            accent_shadow: self.accent_shadow.lerp(other.accent_shadow, t),
            on_accent: self.on_accent.lerp(other.on_accent, t),
            shadow_c1: self.shadow_c1.lerp(other.shadow_c1, t),
            shadow_c2: self.shadow_c2.lerp(other.shadow_c2, t),
            ok: self.ok.lerp(other.ok, t),
            ok_bg: self.ok_bg.lerp(other.ok_bg, t),
            warn: self.warn.lerp(other.warn, t),
            warn_2: self.warn_2.lerp(other.warn_2, t),
            warn_bg: self.warn_bg.lerp(other.warn_bg, t),
            warn_ink: self.warn_ink.lerp(other.warn_ink, t),
            err: self.err.lerp(other.err, t),
            err_2: self.err_2.lerp(other.err_2, t),
            err_bg: self.err_bg.lerp(other.err_bg, t),
        }
    }
}

/// Elevation recipes for cards and buttons (`article.card` / `.btn` box-shadow lists).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShadowProfile {
    /// Dark ambient shadow: `(dx, dy, blur)` in logical pixels.
    pub card_dark: [f32; 3],
    /// Light key shadow. `None` for matte themes（纸面 = MATTE，无亮投影）.
    pub card_light: Option<[f32; 3]>,
    /// Matte themes drop the inset top highlight and inner bottom glow entirely.
    pub card_rim: bool,
    pub button_dark: [f32; 3],
    pub button_light: Option<[f32; 3]>,
}

impl ShadowProfile {
    fn lerp(self, other: Self, t: f32) -> Self {
        fn lerp_shadow(a: Option<[f32; 3]>, b: Option<[f32; 3]>, t: f32) -> Option<[f32; 3]> {
            match (a, b) {
                (Some(a), Some(b)) => Some([
                    lerp(a[0], b[0], t),
                    lerp(a[1], b[1], t),
                    lerp(a[2], b[2], t),
                ]),
                (Some(a), None) => Some([a[0], a[1], lerp(a[2], 0.0, t)]),
                (None, Some(b)) => Some([b[0], b[1], lerp(0.0, b[2], t)]),
                (None, None) => None,
            }
        }
        Self {
            card_dark: [
                lerp(self.card_dark[0], other.card_dark[0], t),
                lerp(self.card_dark[1], other.card_dark[1], t),
                lerp(self.card_dark[2], other.card_dark[2], t),
            ],
            card_light: lerp_shadow(self.card_light, other.card_light, t),
            // The rim is a structural choice; it flips at the midpoint so it never half-exists.
            card_rim: if t < 0.5 { self.card_rim } else { other.card_rim },
            button_dark: [
                lerp(self.button_dark[0], other.button_dark[0], t),
                lerp(self.button_dark[1], other.button_dark[1], t),
                lerp(self.button_dark[2], other.button_dark[2], t),
            ],
            button_light: lerp_shadow(self.button_light, other.button_light, t),
        }
    }
}

/// Gummy button fill recipe: `linear-gradient(145deg, rgba(255,255,255,top_alpha), var(--chip) 60%)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ButtonStyle {
    /// Alpha of the white highlight corner (light themes `.92`, dark themes `.14`).
    pub top_alpha: f32,
    /// Stop position of `--chip` along the fill gradient.
    pub chip_stop: f32,
}

/// Animation recipes. Durations are data so tests can lock them and Reduce Motion can
/// collapse them without touching painters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionSpec {
    /// Full theme cross-fade. Task budget: 600–900 ms.
    pub theme_transition_ms: u32,
    /// Page enter (fade + rise), `moduleIn` in the Web reference (340 ms).
    pub page_enter_ms: u32,
    /// Ripple lifetime of one theme switch (bg-ripple “once” mode, 1500 ms at 60 fps).
    pub ripple_ms: u32,
    /// Concentric rings in the ripple (`涟漪环 11`).
    pub ripple_rings: u32,
    /// Ripple origin in viewport fractions — bottom-right, slightly off-screen (uv 1.02, 1.02).
    pub ripple_origin: [f32; 2],
    /// One full blob drift cycle.
    pub drift_period_ms: u32,
    /// Drift amplitude as a viewport-width fraction per axis (deliberately tiny).
    pub drift_amplitude: [f32; 2],
    /// Drift frame budget — 30 fps is enough for slow ambient motion.
    pub drift_fps: u32,
}

impl ThemeSpec {
    /// Accent colour adjusted until it clears WCAG AA as *text* on the opaque card surface.
    ///
    /// The Web source uses one `--accent` both for fills (gradient pills, primary buttons —
    /// where 3.7:1 is fine as a graphical element) and for small text. The task forbids
    /// dropping text contrast for the sake of fidelity, so text-mode colours walk toward
    /// black (light themes) or white (dark themes) just far enough to pass — against both
    /// the plain card surface and the tinted soft chip (`--accent-soft` / `--*-bg`) they are
    /// most often rendered on. Fills keep the raw Web tone untouched.
    pub fn readable_accent(&self) -> Rgba {
        self.readable_text(self.tokens.accent, self.tokens.accent_soft)
    }

    /// Same treatment for semantic text tones (`--ok` / `--warn` / `--err` with their chips).
    pub fn readable_semantic(&self, color: Rgba, chip: Rgba) -> Rgba {
        self.readable_text(color, chip)
    }

    pub fn readable_text(&self, color: Rgba, chip: Rgba) -> Rgba {
        let surface = self.tokens.panel_solid.over(self.tokens.bg);
        let chip_backdrop = chip.over(self.tokens.bg);
        let mut value = color;
        for _ in 0..48 {
            if contrast_ratio(value, surface) >= TEXT_TARGET_CONTRAST
                && contrast_ratio(value, chip_backdrop) >= CHIP_TARGET_CONTRAST
            {
                break;
            }
            value = if self.dark {
                value.mix(Rgba::rgb(255, 255, 255), 0.07)
            } else {
                value.mix(Rgba::rgb(0, 0, 0), 0.07)
            };
        }
        value
    }

    /// Interpolate two specs for a theme transition. Identity fields (id / label / dark)
    /// snap to the target; everything visual is blended.
    pub fn lerp(from: &ThemeSpec, to: &ThemeSpec, t: f32) -> ThemeSpec {
        let t = t.clamp(0.0, 1.0);
        ThemeSpec {
            id: to.id,
            label: to.label,
            dark: if t < 0.5 { from.dark } else { to.dark },
            background: from.background.lerp(to.background, t),
            tokens: from.tokens.lerp(to.tokens, t),
            radius: lerp(from.radius, to.radius, t),
            radius_s: lerp(from.radius_s, to.radius_s, t),
            glass_blur: lerp(from.glass_blur, to.glass_blur, t),
            shadow: from.shadow.lerp(to.shadow, t),
            button: ButtonStyle {
                top_alpha: lerp(from.button.top_alpha, to.button.top_alpha, t),
                chip_stop: lerp(from.button.chip_stop, to.button.chip_stop, t),
            },
            // Motion timing never blends; it belongs to the theme you are arriving at.
            motion: to.motion,
        }
    }
}

/// The full recipe of one theme.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ThemeSpec {
    /// Stable id matching `ThemePreference::as_str`（UI v1 只有 `paper`）.
    pub id: &'static str,
    pub label: &'static str,
    pub dark: bool,
    pub background: Background,
    pub tokens: Tokens,
    pub radius: f32,
    pub radius_s: f32,
    /// `--glass-blur` in CSS px. The native shell cannot blur what is behind a shape; the
    /// value is kept as data (tests + future backdrops) and the translucent panels emulate it.
    pub glass_blur: f32,
    pub shadow: ShadowProfile,
    pub button: ButtonStyle,
    pub motion: MotionSpec,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ThemeSpec {
        *crate::theme::themes::all()[0]
    }

    #[test]
    fn rgba_round_trips_to_color32() {
        let color = Rgba::hex(0xd5e3ff, 1.0).to_color32();
        assert_eq!(color, Color32::from_rgb(0xd5, 0xe3, 0xff));
        let translucent = Rgba::hex(0x5b7cfa, 0.13).to_color32();
        assert_eq!(translucent.a(), 33);
    }

    #[test]
    fn lerp_endpoints_are_exact_and_midpoint_is_between() {
        let a = Rgba::rgb(0, 0, 0);
        let b = Rgba::rgb(255, 255, 255);
        assert_eq!(a.lerp(b, 0.0), a);
        assert_eq!(a.lerp(b, 1.0), b);
        let mid = a.lerp(b, 0.5);
        assert!(mid.r > a.r && mid.r < b.r);
        // Out-of-range t clamps instead of extrapolating.
        assert_eq!(a.lerp(b, -3.0), a);
        assert_eq!(a.lerp(b, 7.0), b);
    }

    #[test]
    fn spec_interpolation_is_identity_for_the_single_theme() {
        // UI v1 只有一个主题：插值仅在首次应用时退化为恒等映射。
        let paper = crate::theme::themes::by_id("paper").expect("paper");
        let start = ThemeSpec::lerp(paper, paper, 0.0);
        let end = ThemeSpec::lerp(paper, paper, 1.0);
        let mid = ThemeSpec::lerp(paper, paper, 0.5);
        assert_eq!(start.id, "paper");
        assert_eq!(end.id, "paper");
        assert_eq!(mid.radius, paper.radius);
        assert_eq!(mid.tokens.accent, paper.tokens.accent);
        assert!(!mid.dark, "paper is a light theme");
        assert!(mid.tokens.text.is_finite());
    }

    #[test]
    fn contrast_math_matches_wcag_examples() {
        // White on black is 21:1, identical colours are 1:1.
        let ratio = contrast_ratio(Rgba::rgb(255, 255, 255), Rgba::rgb(0, 0, 0));
        assert!((ratio - 21.0).abs() < 0.01);
        let same = contrast_ratio(Rgba::rgb(90, 100, 130), Rgba::rgb(90, 100, 130));
        assert!((same - 1.0).abs() < 0.001);
    }

    #[test]
    fn gradient_sampling_respects_the_48_percent_middle_stop() {
        let background = sample().background;
        assert_eq!(background.gradient_at(0.0), background.gradient[0]);
        assert_eq!(background.gradient_at(0.48), background.gradient[1]);
        assert_eq!(background.gradient_at(1.0), background.gradient[2]);
        let before = background.gradient_at(0.24);
        assert!(before.r >= background.gradient[0].r.min(background.gradient[1].r) - 0.001);
    }
}
