//! Desktop UI preferences: theme, zoom, window geometry, and close behavior.
//!
//! This file only ever stores shell preferences. Task / Memory / Workspace metadata lives in the
//! Core data directory and is never rewritten by the UI. Loading is fail-soft: a missing or
//! damaged preferences file falls back to safe defaults so it can never block startup, and saves
//! are atomic so a crash mid-write cannot corrupt the previous revision.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

pub const MIN_ZOOM: f32 = 0.8;
pub const MAX_ZOOM: f32 = 1.6;
pub const MIN_WINDOW_WIDTH: f32 = 900.0;
pub const MIN_WINDOW_HEIGHT: f32 = 620.0;
pub const DEFAULT_WINDOW_WIDTH: f32 = 1180.0;
pub const DEFAULT_WINDOW_HEIGHT: f32 = 780.0;

const MAX_WINDOW_DIMENSION: f32 = 12_000.0;
const MAX_ABSOLUTE_POSITION: f32 = 40_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

impl ThemePreference {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "system" | "auto" => Some(Self::System),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }

    /// Resolve the preference against the current OS theme.
    pub fn resolves_to_dark(self, system_dark: bool) -> bool {
        match self {
            Self::System => system_dark,
            Self::Light => false,
            Self::Dark => true,
        }
    }
}

impl Default for ThemePreference {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseBehavior {
    /// Closing the window hides it to the tray; Core and running tasks keep going.
    HideToTray,
    /// Closing the window asks for confirmation (if work is in flight) and then exits.
    Quit,
}

impl CloseBehavior {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HideToTray => "hide-to-tray",
            Self::Quit => "quit",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "hide-to-tray" | "hide" | "tray" => Some(Self::HideToTray),
            "quit" | "exit" => Some(Self::Quit),
            _ => None,
        }
    }
}

impl Default for CloseBehavior {
    fn default() -> Self {
        Self::HideToTray
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowGeometry {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub maximized: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UiPrefs {
    pub theme: ThemePreference,
    pub zoom: f32,
    pub close_behavior: CloseBehavior,
    pub geometry: Option<WindowGeometry>,
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            theme: ThemePreference::default(),
            zoom: 1.0,
            close_behavior: CloseBehavior::default(),
            geometry: None,
        }
    }
}

pub fn prefs_file(data_dir: &Path) -> PathBuf {
    data_dir.join("state").join("desktop-ui.json")
}

pub fn clamp_zoom(value: f32) -> f32 {
    if !value.is_finite() {
        return 1.0;
    }
    value.clamp(MIN_ZOOM, MAX_ZOOM)
}

/// Clamp a geometry snapshot into a restorable shape. Returns `None` when the values are not
/// finite at all, which means "no stored geometry" rather than "restore garbage".
pub fn sanitize_geometry(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    maximized: bool,
) -> Option<WindowGeometry> {
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return None;
    }
    if x.abs() > MAX_ABSOLUTE_POSITION || y.abs() > MAX_ABSOLUTE_POSITION {
        return None;
    }
    if width < 200.0 || height < 200.0 {
        return None;
    }
    Some(WindowGeometry {
        x,
        y,
        width: width.clamp(MIN_WINDOW_WIDTH, MAX_WINDOW_DIMENSION),
        height: height.clamp(MIN_WINDOW_HEIGHT, MAX_WINDOW_DIMENSION),
        maximized,
    })
}

fn f32_field(value: Option<&Value>) -> Option<f32> {
    value.and_then(Value::as_f64).map(|number| number as f32)
}

pub fn prefs_from_value(value: &Value) -> UiPrefs {
    let defaults = UiPrefs::default();
    let theme = value
        .get("theme")
        .and_then(Value::as_str)
        .and_then(ThemePreference::parse)
        .unwrap_or(defaults.theme);
    let zoom = f32_field(value.get("zoom"))
        .map(clamp_zoom)
        .unwrap_or(defaults.zoom);
    let close_behavior = value
        .get("closeBehavior")
        .and_then(Value::as_str)
        .and_then(CloseBehavior::parse)
        .unwrap_or(defaults.close_behavior);
    let geometry = sanitize_geometry(
        f32_field(value.pointer("/window/x")).unwrap_or(f32::NAN),
        f32_field(value.pointer("/window/y")).unwrap_or(f32::NAN),
        f32_field(value.pointer("/window/width")).unwrap_or(f32::NAN),
        f32_field(value.pointer("/window/height")).unwrap_or(f32::NAN),
        value
            .pointer("/window/maximized")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
    UiPrefs {
        theme,
        zoom,
        close_behavior,
        geometry,
    }
}

impl UiPrefs {
    pub fn to_value(&self) -> Value {
        let mut value = json!({
            "version": 1,
            "theme": self.theme.as_str(),
            "zoom": self.zoom,
            "closeBehavior": self.close_behavior.as_str(),
        });
        if let Some(geometry) = self.geometry {
            value["window"] = json!({
                "x": geometry.x,
                "y": geometry.y,
                "width": geometry.width,
                "height": geometry.height,
                "maximized": geometry.maximized,
            });
        }
        value
    }

    /// Load preferences; never fails. The optional string is a human-readable warning.
    pub fn load(data_dir: &Path) -> (Self, Option<String>) {
        let file = prefs_file(data_dir);
        let raw = match fs::read_to_string(&file) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return (Self::default(), None);
            }
            Err(error) => {
                return (
                    Self::default(),
                    Some(format!("界面偏好读取失败（将使用默认值）：{error}")),
                );
            }
        };
        let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
        match serde_json::from_str::<Value>(raw) {
            Ok(value) if value.is_object() => (prefs_from_value(&value), None),
            Ok(_) => (
                Self::default(),
                Some("界面偏好格式异常（将使用默认值）。".to_owned()),
            ),
            Err(error) => (
                Self::default(),
                Some(format!("界面偏好解析失败（将使用默认值）：{error}")),
            ),
        }
    }

    /// Best-effort atomic save: unique temporary file in the same directory, then rename.
    pub fn save(&self, data_dir: &Path) -> Result<(), String> {
        let file = prefs_file(data_dir);
        let directory = file
            .parent()
            .ok_or_else(|| "界面偏好路径无效。".to_owned())?;
        fs::create_dir_all(directory).map_err(|error| format!("创建偏好目录失败：{error}"))?;
        let temporary = directory.join(format!("desktop-ui.json.{}.tmp", std::process::id()));
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&self.to_value())
                .map_err(|error| format!("序列化偏好失败：{error}"))?
        );
        fs::write(&temporary, text).map_err(|error| format!("写入偏好失败：{error}"))?;
        fs::rename(&temporary, &file).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("替换偏好文件失败：{error}")
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("cetamesh-ui-prefs-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn malformed_values_fall_back_to_safe_defaults() {
        let prefs = prefs_from_value(&json!({
            "theme": "neon",
            "zoom": 99.0,
            "closeBehavior": 7,
            "window": { "x": "left", "width": 10 }
        }));
        assert_eq!(prefs.theme, ThemePreference::System);
        assert_eq!(prefs.zoom, MAX_ZOOM);
        assert_eq!(prefs.close_behavior, CloseBehavior::HideToTray);
        assert!(prefs.geometry.is_none());
    }

    #[test]
    fn zoom_is_clamped_and_geometry_rejects_non_finite_values() {
        assert_eq!(clamp_zoom(f32::NAN), 1.0);
        assert_eq!(clamp_zoom(0.1), MIN_ZOOM);
        assert_eq!(clamp_zoom(10.0), MAX_ZOOM);
        assert_eq!(clamp_zoom(1.25), 1.25);
        assert!(sanitize_geometry(f32::NAN, 0.0, 1180.0, 780.0, false).is_none());
        assert!(sanitize_geometry(0.0, 0.0, 10.0, 10.0, false).is_none());
        let geometry = sanitize_geometry(-1920.0, 40.0, 400.0, 300.0, true)
            .expect("negative monitor positions are valid");
        assert_eq!(geometry.width, MIN_WINDOW_WIDTH);
        assert_eq!(geometry.height, MIN_WINDOW_HEIGHT);
        assert!(geometry.maximized);
    }

    #[test]
    fn save_load_round_trip_is_atomic_and_corruption_is_fail_soft() {
        let dir = temp_dir();
        let prefs = UiPrefs {
            theme: ThemePreference::Dark,
            zoom: 1.25,
            close_behavior: CloseBehavior::Quit,
            geometry: sanitize_geometry(120.0, 80.0, 1280.0, 800.0, false),
        };
        prefs.save(&dir).expect("save prefs");
        let (loaded, warning) = UiPrefs::load(&dir);
        assert!(warning.is_none());
        assert_eq!(loaded, prefs);
        let leftovers: Vec<_> = fs::read_dir(dir.join("state"))
            .expect("state dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic save must not leave temp files"
        );

        fs::write(prefs_file(&dir), "{ not json").expect("write corrupt prefs");
        let (fallback, warning) = UiPrefs::load(&dir);
        assert_eq!(fallback, UiPrefs::default());
        assert!(warning.is_some());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn theme_resolution_follows_the_system_preference() {
        assert!(ThemePreference::System.resolves_to_dark(true));
        assert!(!ThemePreference::System.resolves_to_dark(false));
        assert!(ThemePreference::Dark.resolves_to_dark(false));
        assert!(!ThemePreference::Light.resolves_to_dark(true));
        assert_eq!(
            ThemePreference::parse("AUTO"),
            Some(ThemePreference::System)
        );
        assert_eq!(
            CloseBehavior::parse("tray"),
            Some(CloseBehavior::HideToTray)
        );
    }
}
