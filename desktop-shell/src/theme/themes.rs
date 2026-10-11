//! The single CetaMesh Desktop theme: 纸面工作台（Paper Workbench）。
//!
//! UI v1 决定（Owner）：主题收敛为方案 01 的「纸面」样式——暖纸底、鼠尾草绿点缀、
//! 哑光卡片与柔和描边；此前的十主题配方全部移除，`ThemePreference` 里的历史取值
//! 一律回落到本主题。视觉事实源是探索稿
//! `design-demos/ui-ia-exploration-2026-10/p01.html` 的 design tokens。

use crate::ui_prefs::ThemePreference;

use super::spec::{
    Background, Blob, BlobSlot, ButtonStyle, Fog, MotionSpec, Rgba, ShadowProfile, ThemeSpec,
    Tokens,
};

/// Blob layout template (`.bg-decor::before`): 纸面主题只留一点若有若无的鼠尾草晕染，
/// 其余位置隐藏；布局网格与旧主题保持一致，方便未来恢复。
const BLOB_TEMPLATE: [Blob; 3] = [
    Blob {
        color: Rgba::rgb(0, 0, 0),
        center: [0.15, 0.10],
        radius_vw: [0.44, 0.44],
        fade: 0.62,
    },
    Blob {
        color: Rgba::rgb(0, 0, 0),
        center: [0.88, 0.24],
        radius_vw: [0.40, 0.40],
        fade: 0.64,
    },
    Blob {
        color: Rgba::rgb(0, 0, 0),
        center: [0.60, 0.94],
        radius_vw: [0.46, 0.46],
        fade: 0.62,
    },
];

/// Top fog template (`.bg-decor::after`): 130vw × 92vh at (50 %, −12 %), transparent at 56 %.
const FOG_TEMPLATE: Fog = Fog {
    color: Rgba::rgb(255, 255, 255),
    center: [0.50, -0.12],
    radius_vw: 1.30,
    radius_vh: 0.92,
    fade: 0.56,
};

const fn blobs(colors: [Rgba; 3]) -> [BlobSlot; 3] {
    [
        BlobSlot(Blob {
            color: colors[0],
            ..BLOB_TEMPLATE[0]
        }),
        BlobSlot(Blob {
            color: colors[1],
            ..BLOB_TEMPLATE[1]
        }),
        BlobSlot(Blob {
            color: colors[2],
            ..BLOB_TEMPLATE[2]
        }),
    ]
}

const fn fog(alpha: f32) -> Fog {
    Fog {
        color: FOG_TEMPLATE.color.with_alpha(alpha),
        ..FOG_TEMPLATE
    }
}

/// 纸面是哑光材质：柔和下投影，无糖玻璃 rim（对齐方案 01 的 `box-shadow: 0 8px 22px`）。
const MATTE: ShadowProfile = ShadowProfile {
    card_dark: [0.0, 8.0, 22.0],
    card_light: None,
    card_rim: false,
    button_dark: [0.0, 2.0, 8.0],
    button_light: None,
};

/// 浅色主题按钮填充（`.btn` 的 `rgba(255,255,255,.92)` 顶部光）。
const BUTTON_LIGHT: ButtonStyle = ButtonStyle {
    top_alpha: 0.92,
    chip_stop: 0.60,
};

/// 动效与旧主题一致（页面浮升 / 涟漪）；纸面没有主题间切换，过渡引擎只负责首次应用。
const MOTION: MotionSpec = MotionSpec {
    theme_transition_ms: 700,
    page_enter_ms: 340,
    ripple_ms: 1_300,
    ripple_rings: 11,
    ripple_origin: [1.02, 1.02],
    drift_period_ms: 48_000,
    drift_amplitude: [0.016, 0.020],
    drift_fps: 30,
};

/// 纸面工作台（方案 01 探索稿 token 的 1:1 转写）。
const PAPER: ThemeSpec = ThemeSpec {
    id: "paper",
    label: "纸面",
    dark: false,
    background: Background {
        // 暖纸三段渐变（#f4f3ee → #f1f0ea → #efeee7），几乎全平。
        gradient: [
            Rgba::hex(0xf4f3ee, 1.0),
            Rgba::hex(0xf1f0ea, 1.0),
            Rgba::hex(0xefeee7, 1.0),
        ],
        gradient_angle: 130.0,
        // 一点极淡的鼠尾草晕染，其余隐藏。
        blobs: blobs([
            Rgba::hex(0x8fae94, 0.10),
            Rgba::hex(0x000000, 0.0),
            Rgba::hex(0x000000, 0.0),
        ]),
        fog: fog(0.35),
    },
    tokens: Tokens {
        bg: Rgba::hex(0xf1f0ea, 1.0),
        bg_soft: Rgba::hex(0xf7f6f1, 1.0),
        panel: Rgba::hex(0xfbfaf6, 0.85),
        panel_solid: Rgba::hex(0xfbfaf6, 0.96),
        glass_weak: Rgba::hex(0xf7f6f1, 0.60),
        chip: Rgba::hex(0xeceae1, 1.0),
        input_bg: Rgba::hex(0xffffff, 0.78),
        hover: Rgba::hex(0xe6e4da, 0.85),
        border: Rgba::hex(0xdcdad0, 1.0),
        border_soft: Rgba::hex(0xb9b6a8, 0.35),
        edge_hi: Rgba::hex(0xffffff, 0.85),
        edge_lo: Rgba::hex(0x8a8778, 0.10),
        // 墨色文字（#2e3630）；text_2/text_3 按壳内 ≥4.5:1 的对比度标准加深。
        text: Rgba::hex(0x2e3630, 1.0),
        text_2: Rgba::hex(0x565e55, 1.0),
        text_3: Rgba::hex(0x686f66, 1.0),
        // 方案 01 的鼠尾草（#7d9b82）加深一档：保证 on_accent 文本 ≥3:1（AA Large）。
        accent: Rgba::hex(0x75937b, 1.0),
        // 渐变端点取中鼠尾草（比探索稿的浅端深一档），保证胶囊文字全程 ≥3:1。
        accent_2: Rgba::hex(0x8fae94, 1.0),
        accent_soft: Rgba::hex(0x7d9b82, 0.14),
        accent_shadow: Rgba::hex(0x5f8467, 0.35),
        on_accent: Rgba::hex(0xf6f9f5, 1.0),
        shadow_c1: Rgba::hex(0x8a8778, 0.28),
        shadow_c2: Rgba::hex(0xffffff, 0.85),
        ok: Rgba::hex(0x5f8467, 1.0),
        ok_bg: Rgba::hex(0x5f8467, 0.13),
        warn: Rgba::hex(0xb08a3e, 1.0),
        warn_2: Rgba::hex(0xcaa14e, 1.0),
        warn_bg: Rgba::hex(0xb08a3e, 0.15),
        warn_ink: Rgba::hex(0xffffff, 1.0),
        err: Rgba::hex(0xb0715d, 1.0),
        err_2: Rgba::hex(0xc98d7c, 1.0),
        err_bg: Rgba::hex(0xb0715d, 0.14),
    },
    radius: 18.0,
    radius_s: 12.0,
    glass_blur: 8.0,
    shadow: MATTE,
    button: BUTTON_LIGHT,
    motion: MOTION,
};

/// The only theme, in `ThemePreference::THEMES` order.
pub const ALL: [&ThemeSpec; 1] = [&PAPER];

#[cfg(test)]
pub fn all() -> &'static [&'static ThemeSpec] {
    &ALL
}

pub fn by_id(id: &str) -> Option<&'static ThemeSpec> {
    ALL.iter().copied().find(|spec| spec.id == id)
}

/// Resolve a preference to the concrete theme recipe. 历史偏好值（soda/deep/…）
/// 一律落到纸面：`ThemePreference::parse` 已做兼容归一，这里再兜底一次。
pub fn spec_for(preference: ThemePreference, _system_dark: bool) -> &'static ThemeSpec {
    by_id(preference.resolve(false).as_str()).unwrap_or(&PAPER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use eframe::egui;
    use crate::theme::spec::contrast_ratio;

    #[test]
    fn every_preference_resolves_to_the_paper_spec() {
        for preference in ThemePreference::THEMES {
            let spec = spec_for(preference, false);
            assert_eq!(spec.id, "paper");
            let spec = spec_for(preference, true);
            assert_eq!(spec.id, "paper", "唯一的主题是浅色纸面，不随系统变暗");
        }
        assert_eq!(spec_for(ThemePreference::System, false).id, "paper");
        assert_eq!(spec_for(ThemePreference::System, true).id, "paper");
    }

    #[test]
    fn historical_theme_ids_are_gone() {
        for legacy in ["soda", "deep", "warm", "ink", "forest", "rose", "sand", "ice", "dusk", "violet"] {
            assert_eq!(by_id(legacy), None, "旧主题必须被移除：{legacy}");
        }
        assert_eq!(by_id("paper").map(|spec| spec.label), Some("纸面"));
    }

    #[test]
    fn paper_spec_is_complete_and_finite() {
        assert!(!PAPER.label.is_empty());
        assert!(PAPER.radius >= 4.0 && PAPER.radius <= 32.0);
        assert!(PAPER.radius_s >= 4.0 && PAPER.radius_s <= PAPER.radius + 4.0);
        assert!(PAPER.glass_blur >= 0.0);
        assert!(!PAPER.dark, "纸面是浅色主题");
        // 方案 01 的核心 token 逐值核对（探索稿 p01 的 design tokens）。
        assert_eq!(PAPER.tokens.bg.to_color32(), egui::Color32::from_rgb(0xf1, 0xf0, 0xea));
        assert_eq!(PAPER.tokens.accent.to_color32(), egui::Color32::from_rgb(0x75, 0x93, 0x7b));
        assert_eq!(PAPER.tokens.text.to_color32(), egui::Color32::from_rgb(0x2e, 0x36, 0x30));
        assert!(PAPER.tokens.text.is_finite());
    }

    #[test]
    fn paper_tokens_meet_the_shell_contrast_bar() {
        let surface = PAPER.tokens.panel_solid.over(PAPER.tokens.bg);
        for text in [PAPER.tokens.text, PAPER.tokens.text_2, PAPER.tokens.text_3] {
            assert!(
                contrast_ratio(text, surface) >= 4.5,
                "paper text tokens must stay readable on the paper card"
            );
        }
        assert!(contrast_ratio(PAPER.tokens.on_accent, PAPER.tokens.accent) >= 3.0);
    }
}
