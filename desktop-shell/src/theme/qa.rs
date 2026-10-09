//! Debug-only screenshot QA driver for the theme acceptance pass.
//!
//! Not part of the product: the whole module is compiled only in debug builds
//! (`#[cfg(debug_assertions)]` on the module declaration), so the release binary carries no
//! screenshot surface at all. It swaps themes through the real theme engine, waits for the
//! transition to settle, asks eframe for a viewport screenshot and writes a PNG — the exact
//! pixels the user would see at 1280×800.
//!
//! PNG encoding is hand-rolled (stored-deflate blocks) so the shell gains no new dependency
//! for a QA-only feature.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use eframe::egui;

use crate::ui_prefs::ThemePreference;

/// Which product page a shot must show. QA-only: the driver switches the real navigation,
/// so the captured pixels are the real page (including the new product-service pages).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QaPage {
    Home,
    Settings,
    About,
    Feedback,
    Onboarding,
}

/// One screenshot request.
#[derive(Clone, Debug)]
pub struct ShotSpec {
    pub label: String,
    pub theme: ThemePreference,
    /// Page to navigate to before shooting.
    pub page: QaPage,
}

/// How long a freshly applied theme is given to finish its 700 ms cross-fade plus layout.
pub const SETTLE: Duration = Duration::from_millis(1_600);

/// Give up on one shot after this long (e.g. the compositor never answered).
const SHOT_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Apply the shot's theme / page.
    Apply,
    /// Let the transition settle.
    Wait,
    /// Screenshot requested; waiting for the image event.
    Capture,
}

/// The full QA run: ten theme shots on Home, the Soda Settings shot, then the three
/// product-service pages (About / Feedback / Onboarding) so UI changes there are visually covered.
pub struct ScreenshotPlan {
    pub dir: PathBuf,
    pub shots: Vec<ShotSpec>,
    pub index: usize,
    pub stage: Stage,
    pub since: Instant,
    pub finished: bool,
    pub requested: bool,
}

impl ScreenshotPlan {
    pub fn new(dir: &Path) -> Self {
        let mut shots: Vec<ShotSpec> = ThemePreference::THEMES
            .iter()
            .enumerate()
            .map(|(position, theme)| ShotSpec {
                label: format!("{:02}-{}-home", position + 1, theme.as_str()),
                theme: *theme,
                page: QaPage::Home,
            })
            .collect();
        shots.push(ShotSpec {
            label: "11-soda-settings".to_owned(),
            theme: ThemePreference::Soda,
            page: QaPage::Settings,
        });
        // 产品化任务 D：三个新产品页各自留一张 Soda 主题截图（debug-only 视觉验收）。
        for (label, page) in [
            ("12-soda-about", QaPage::About),
            ("13-soda-feedback", QaPage::Feedback),
            ("14-soda-onboarding", QaPage::Onboarding),
        ] {
            shots.push(ShotSpec {
                label: label.to_owned(),
                theme: ThemePreference::Soda,
                page,
            });
        }
        Self {
            dir: dir.to_path_buf(),
            shots,
            index: 0,
            stage: Stage::Apply,
            since: Instant::now(),
            finished: false,
            requested: false,
        }
    }

    pub fn current(&self) -> Option<&ShotSpec> {
        self.shots.get(self.index)
    }

    pub fn advance(&mut self, now: Instant) {
        self.requested = false;
        self.index += 1;
        self.stage = Stage::Apply;
        self.since = now;
        if self.index >= self.shots.len() {
            self.finished = true;
        }
    }

    pub fn set_stage(&mut self, stage: Stage, now: Instant) {
        self.stage = stage;
        self.since = now;
    }

    pub fn timed_out(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.since) > SHOT_TIMEOUT
    }

    /// The screenshot image for this frame, if eframe delivered one.
    pub fn take_screenshot(ctx: &egui::Context) -> Option<std::sync::Arc<egui::ColorImage>> {
        ctx.input(|input| {
            input.events.iter().find_map(|event| match event {
                egui::Event::Screenshot { image, .. } => Some(image.clone()),
                _ => None,
            })
        })
    }
}

// ---------------------------------------------------------------------------
// Minimal PNG writer (stored deflate blocks; no compression, no dependencies)
// ---------------------------------------------------------------------------

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xedb8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in bytes {
        a = (a + byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + raw.len() / 65_535 * 5 + 16);
    out.extend_from_slice(&[0x78, 0x01]); // CMF/FLG: deflate, 32 KiB window, no dict
    let mut rest = raw;
    loop {
        let block = rest.len().min(65_535);
        let final_block = block == rest.len();
        out.push(if final_block { 1 } else { 0 }); // BFINAL | BTYPE=00 (stored)
        let len = block as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(&rest[..block]);
        rest = &rest[block..];
        if final_block {
            break;
        }
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

fn png_chunk(kind: &[u8; 4], data: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut payload = Vec::with_capacity(4 + data.len());
    payload.extend_from_slice(kind);
    payload.extend_from_slice(data);
    out.extend_from_slice(&payload);
    out.extend_from_slice(&crc32(&payload).to_be_bytes());
}

/// Encode RGBA8 pixels as a PNG (stored deflate; valid, uncompressed, dependency-free).
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), (width as usize) * (height as usize) * 4);
    let mut raw = Vec::with_capacity(rgba.len() + height as usize);
    for row in 0..height as usize {
        raw.push(0); // filter: none
        let start = row * width as usize * 4;
        raw.extend_from_slice(&rgba[start..start + width as usize * 4]);
    }
    let mut out = Vec::with_capacity(raw.len() + raw.len() / 200 + 128);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit, RGBA, deflate, no filter, no interlace
    png_chunk(b"IHDR", &ihdr, &mut out);
    png_chunk(b"IDAT", &zlib_stored(&raw), &mut out);
    png_chunk(b"IEND", &[], &mut out);
    out
}

/// Write one captured frame to `dir/<label>.png`.
pub fn save_color_image(dir: &Path, label: &str, image: &egui::ColorImage) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("创建截图目录失败：{error}"))?;
    let [width, height] = image.size;
    let mut rgba = Vec::with_capacity(width * height * 4);
    for pixel in &image.pixels {
        let [r, g, b, a] = pixel.to_srgba_unmultiplied();
        rgba.extend_from_slice(&[r, g, b, a]);
    }
    let png = encode_png(width as u32, height as u32, &rgba);
    let path = dir.join(format!("{label}.png"));
    std::fs::write(&path, png).map_err(|error| format!("写入截图失败：{error}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_deflate_wraps_large_payloads_in_multiple_blocks() {
        let payload = vec![7u8; 70_000];
        let zlib = zlib_stored(&payload);
        // Two blocks: header (2) + block1 (1+4+65535) + block2 (1+4+4465) + adler (4).
        assert_eq!(zlib.len(), 2 + 5 + 65_535 + 5 + 4_465 + 4);
        assert_eq!(zlib[0], 0x78);
        assert_eq!(&zlib[zlib.len() - 4..], &adler32(&payload).to_be_bytes());
    }

    #[test]
    fn png_header_and_checksums_are_well_formed() {
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 255, // 2 px
        ];
        let png = encode_png(2, 1, &rgba);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes([png[16], png[17], png[18], png[19]]), 2);
        assert_eq!(u32::from_be_bytes([png[20], png[21], png[22], png[23]]), 1);
        // The file must end with a valid IEND chunk whose CRC covers "IEND".
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        let expected = crc32(b"IEND");
        assert_eq!(&png[png.len() - 4..], &expected.to_be_bytes());
    }

    #[test]
    fn plan_covers_ten_themes_plus_product_pages_and_advances_to_finish() {
        let plan = ScreenshotPlan::new(Path::new("unused"));
        // 10 themes on Home + Settings + 产品化任务 D 的三个产品页。
        assert_eq!(plan.shots.len(), 14);
        assert_eq!(plan.shots[0].theme, ThemePreference::Soda);
        assert_eq!(plan.shots[0].page, QaPage::Home);
        assert_eq!(plan.shots[10].page, QaPage::Settings);
        assert_eq!(plan.shots[11].page, QaPage::About);
        assert_eq!(plan.shots[12].page, QaPage::Feedback);
        assert_eq!(plan.shots[13].page, QaPage::Onboarding);
        for spec in &plan.shots {
            assert!(!spec.label.contains(['/', '\\', ' ']));
        }
        let mut plan = ScreenshotPlan::new(Path::new("unused"));
        let now = Instant::now();
        for _ in 0..14 {
            plan.advance(now);
        }
        assert!(plan.finished);
        assert!(plan.current().is_none());
    }
}
