//! Native painter for the CetaMesh theme system.
//!
//! Reproduces the Web visual stack (`.bg-decor` gradient + blobs + fog, gummy glass cards,
//! soft shadows, inset rims, gummy buttons, the theme-switch ripple) with egui primitives —
//! `Mesh` strips for linear gradients, tinted soft-disc textures for radial glows, layered
//! rounded rects for the neumorphic shadows. No WebView, no shader.
//!
//! Layer order matters and is documented per function; callers paint the background first
//! (on the background layer) and cards/buttons before their content.

use eframe::egui::{
    self,
    Color32, CornerRadius, Mesh, Pos2, Rect, Shape, Stroke, StrokeKind, TextureHandle,
    TextureOptions, Vec2,
};

use super::spec::{Background, Rgba, ThemeSpec};

/// Falloff profile of the radial helper textures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscProfile {
    /// `alpha = 1 - u` — matches a CSS radial-gradient's default linear stop interpolation
    /// (used for the top fog and for inset bottom glows).
    Linear,
    /// `alpha = (1 - u²)²` — a blur-like falloff for blurred blobs and soft shadows.
    Soft,
}

/// Alpha profile of the helper discs. Pure math so it is unit-testable without a GPU.
pub fn disc_alpha(profile: DiscProfile, u: f32) -> f32 {
    let u = u.clamp(0.0, 1.0);
    match profile {
        DiscProfile::Linear => 1.0 - u,
        DiscProfile::Soft => {
            let core = 1.0 - u * u;
            core * core
        }
    }
}

const DISC_SIZE: usize = 256;

fn build_disc(profile: DiscProfile) -> egui::ColorImage {
    let mut bytes = Vec::with_capacity(DISC_SIZE * DISC_SIZE * 4);
    let center = (DISC_SIZE as f32 - 1.0) / 2.0;
    for y in 0..DISC_SIZE {
        for x in 0..DISC_SIZE {
            let dx = (x as f32 - center) / center;
            let dy = (y as f32 - center) / center;
            let u = (dx * dx + dy * dy).sqrt();
            let alpha = (disc_alpha(profile, u) * 255.0).round() as u8;
            bytes.extend_from_slice(&[255, 255, 255, alpha]);
        }
    }
    egui::ColorImage::from_rgba_unmultiplied([DISC_SIZE, DISC_SIZE], &bytes)
}

/// Lazily-created radial helper texture, cached in egui's data store per profile.
pub fn disc_texture(ctx: &egui::Context, profile: DiscProfile) -> TextureHandle {
    let (id, name) = match profile {
        DiscProfile::Linear => (
            egui::Id::new("cetamesh-theme-disc-linear"),
            "cetamesh-disc-linear",
        ),
        DiscProfile::Soft => (
            egui::Id::new("cetamesh-theme-disc-soft"),
            "cetamesh-disc-soft",
        ),
    };
    if let Some(handle) = ctx.data_mut(|data| data.get_temp::<TextureHandle>(id)) {
        return handle;
    }
    // `load_texture` must not run inside `data_mut` — it re-enters the same store.
    let handle = ctx.load_texture(name, build_disc(profile), TextureOptions::LINEAR);
    ctx.data_mut(|data| data.insert_temp(id, handle.clone()));
    handle
}

/// Direction of a CSS `linear-gradient(<angle>deg, …)` in screen coordinates (y down).
/// 0° points up, angles grow clockwise; 130° therefore points right-and-down.
pub fn gradient_direction(angle_deg: f32) -> Vec2 {
    let radians = angle_deg.to_radians();
    Vec2::new(radians.sin(), -radians.cos())
}

/// Projection positions of the rect corners onto the gradient axis, normalised to 0..=1.
/// Pure geometry, used by the strip builder and by tests.
pub fn gradient_span(rect: Rect, angle_deg: f32) -> (Vec2, f32, Pos2) {
    let dir = gradient_direction(angle_deg);
    let span = (rect.width() * dir.x.abs()) + (rect.height() * dir.y.abs());
    (dir, span.max(1.0), rect.center())
}

/// Burnt-in theme colours sampled along the gradient for the given strip boundaries.
pub fn gradient_strip_colors(background: &Background, boundaries: &[f32]) -> Vec<Rgba> {
    boundaries
        .iter()
        .map(|&t| background.gradient_at(t))
        .collect()
}

/// Strip boundaries of the 3-stop gradient: exact at the stops, subdivided between them so
/// the piecewise-linear mesh approximates the gradient to sub-pixel error.
pub fn gradient_boundaries(segments: u32) -> Vec<f32> {
    let segments = segments.max(2);
    let mut boundaries = Vec::with_capacity(segments as usize + 1);
    for step in 0..=segments {
        boundaries.push(step as f32 / segments as f32);
    }
    boundaries
}

/// Paint the three-stop linear background gradient as a strip mesh.
fn paint_gradient(painter: &egui::Painter, rect: Rect, background: &Background) {
    let (dir, span, center) = gradient_span(rect, background.gradient_angle);
    let perpendicular = Vec2::new(-dir.y, dir.x) * (span * 1.5);
    let boundaries = gradient_boundaries(32);
    let colors = gradient_strip_colors(background, &boundaries);
    let mut mesh = Mesh::default();
    for pair in boundaries.windows(2).zip(colors.windows(2)) {
        let (t0, t1) = (pair.0[0], pair.0[1]);
        let (c0, c1) = (pair.1[0], pair.1[1]);
        let p0 = center + dir * (t0 - 0.5) * span;
        let p1 = center + dir * (t1 - 0.5) * span;
        let base = mesh.vertices.len() as u32;
        // Colours are flat along each strip and linear along the gradient axis.
        mesh.colored_vertex(p0 - perpendicular, c0.to_color32());
        mesh.colored_vertex(p0 + perpendicular, c0.to_color32());
        mesh.colored_vertex(p1 + perpendicular, c1.to_color32());
        mesh.colored_vertex(p1 - perpendicular, c1.to_color32());
        mesh.add_triangle(base, base + 1, base + 2);
        mesh.add_triangle(base, base + 2, base + 3);
    }
    painter.add(Shape::mesh(mesh));
}

/// Paint the ambient blob layer. `drift` is the current drift phase in radians; `None` keeps
/// the blobs at their rest positions (Reduce Motion, or the frozen idle background).
fn paint_blobs(painter: &egui::Painter, ctx: &egui::Context, rect: Rect, spec: &ThemeSpec, drift: Option<f32>) {
    let disc = disc_texture(ctx, DiscProfile::Soft);
    let background = &spec.background;
    for (index, slot) in background.blobs.iter().enumerate() {
        let blob = slot.0;
        if blob.color.a <= 0.004 {
            continue;
        }
        let offset = match (drift, spec.motion) {
            (Some(phase), motion) => super::motion::blob_drift_offset(phase, index, motion.drift_amplitude),
            (None, _) => [0.0, 0.0],
        };
        let center = Pos2::new(
            rect.min.x + (blob.center[0] + offset[0]) * rect.width(),
            rect.min.y + (blob.center[1] + offset[1]) * rect.height(),
        );
        // CSS radial radius × fade stop; the Web layer is additionally blurred by 72 px,
        // which the soft falloff profile approximates (plus a small radius widening).
        let fade_radius = blob.radius_vw[0] * rect.width() * blob.fade * 1.12 + 24.0;
        let size = Vec2::splat(fade_radius * 2.0);
        painter.image(
            disc.id(),
            Rect::from_center_size(center, size),
            Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
            blob.color.to_color32(),
        );
    }
}

/// Paint the top fog (`.bg-decor::after`): one huge, linear-falloff white radial clamped to
/// the top edge. Skipped for themes whose CSS hides the decor layer (Ink / Sand / Dusk).
fn paint_fog(painter: &egui::Painter, ctx: &egui::Context, rect: Rect, spec: &ThemeSpec) {
    let fog = spec.background.fog;
    if fog.color.a <= 0.004 {
        return;
    }
    let disc = disc_texture(ctx, DiscProfile::Linear);
    let center = Pos2::new(
        rect.min.x + fog.center[0] * rect.width(),
        rect.min.y + fog.center[1] * rect.height(),
    );
    let radius = Vec2::new(
        fog.radius_vw * rect.width() * fog.fade,
        fog.radius_vh * rect.height() * fog.fade,
    );
    painter.image(
        disc.id(),
        Rect::from_center_size(center, radius * 2.0),
        Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
        fog.color.to_color32(),
    );
}

/// Paint the whole background stack: gradient → blobs → fog.
pub fn paint_background(
    painter: &egui::Painter,
    ctx: &egui::Context,
    rect: Rect,
    spec: &ThemeSpec,
    drift: Option<f32>,
) {
    let painter = painter.with_clip_rect(rect);
    painter.rect_filled(rect, CornerRadius::ZERO, spec.tokens.bg.to_color32());
    paint_gradient(&painter, rect, &spec.background);
    paint_blobs(&painter, ctx, rect, spec, drift);
    paint_fog(&painter, ctx, rect, spec);
}

/// Paint the theme-switch ripple: concentric rings expanding from the bottom-right corner,
/// coloured by interpolating the two themes' gradients (from → to) at each ring position.
/// Only runs while a theme transition is in flight and never repaints when idle.
pub fn paint_ripple(
    painter: &egui::Painter,
    rect: Rect,
    from: &ThemeSpec,
    to: &ThemeSpec,
    t: f32,
    rings: u32,
) {
    let painter = painter.with_clip_rect(rect);
    let origin = Pos2::new(
        rect.min.x + to.motion.ripple_origin[0] * rect.width(),
        rect.min.y + to.motion.ripple_origin[1] * rect.height(),
    );
    let span = (origin - rect.min).length();
    for ring in super::motion::ripple_rings(t, rings) {
        let position = (ring.radius * 0.5).clamp(0.0, 1.0);
        let base = from.background.gradient_at(position);
        let target = to.background.gradient_at(position);
        let color = base.lerp(target, t).to_color32();
        let highlight = Color32::from_rgba_unmultiplied(255, 255, 255, (ring.alpha * 255.0 * 0.9) as u8);
        let radius = (ring.radius * span).max(1.0);
        painter.circle_stroke(
            origin,
            radius,
            Stroke::new(1.5 + 14.0 * ring.alpha / 0.16, highlight),
        );
        painter.circle_stroke(
            origin,
            radius * 0.985,
            Stroke::new(6.0, color.gamma_multiply(ring.alpha)),
        );
    }
}

/// Layered soft shadow behind a rounded rect — the native reading of the Web's large
/// neumorphic box-shadows (`16px 18px 42px` dark + light key). Returned back-to-front so
/// callers can insert them behind content without re-entering the painter.
pub fn soft_shadow_shapes(
    rect: Rect,
    corner_radius: f32,
    offset: Vec2,
    blur: f32,
    color: Rgba,
) -> Vec<Shape> {
    let mut shapes = Vec::new();
    if color.a <= 0.002 || blur <= 0.5 {
        return shapes;
    }
    let steps = 12;
    let offset_rect = rect.translate(offset);
    for step in 0..steps {
        let fraction = (step as f32 + 1.0) / steps as f32;
        let grow = blur * fraction;
        let alpha = color.a * (1.0 - fraction).powi(2) * 2.4 / steps as f32;
        if alpha <= 0.0015 {
            continue;
        }
        shapes.push(Shape::rect_filled(
            offset_rect.expand(grow),
            CornerRadius::same(corner_radius as u8),
            Rgba { a: alpha, ..color }.to_color32(),
        ));
    }
    shapes
}

/// Layered soft shadow painted directly (for buttons, wells and one-off chrome).
pub fn paint_soft_shadow(
    painter: &egui::Painter,
    rect: Rect,
    corner_radius: f32,
    offset: Vec2,
    blur: f32,
    color: Rgba,
) {
    painter.extend(soft_shadow_shapes(rect, corner_radius, offset, blur, color));
}

/// Stroked path along the top edge and both upper corner arcs — the exact silhouette of the
/// CSS `inset 0 1.5px 0 var(--edge-hi)` rim on a rounded rect.
fn top_rim_shape(rect: Rect, radius: f32, color: Rgba) -> Shape {
    let radius = radius.clamp(0.0, rect.width().min(rect.height()) / 2.0);
    let segments = 8;
    let mut points = Vec::with_capacity((segments + 2) * 2);
    // Up the left corner arc, then across the top, then down the right corner arc.
    for step in 0..=segments {
        let angle = std::f32::consts::FRAC_PI_2 + (step as f32 / segments as f32) * std::f32::consts::FRAC_PI_2;
        points.push(Pos2::new(
            rect.min.x + radius - radius * angle.sin(),
            rect.min.y + radius - radius * angle.cos(),
        ));
    }
    for step in 0..=segments {
        let angle = (step as f32 / segments as f32) * std::f32::consts::FRAC_PI_2;
        points.push(Pos2::new(
            rect.max.x - radius + radius * angle.sin(),
            rect.min.y + radius - radius * angle.cos(),
        ));
    }
    Shape::line(points, Stroke::new(1.5, color.to_color32()))
}

/// Vertical two-stop gradient strip (transparent → colour) used for the inner bottom glow.
fn vertical_glow_shape(rect: Rect, color: Rgba) -> Shape {
    let top = color.with_alpha(0.0);
    let mut mesh = Mesh::default();
    let corners = [
        (rect.left_top(), top),
        (rect.right_top(), top),
        (rect.right_bottom(), color),
        (rect.left_bottom(), color),
    ];
    for (point, tint) in corners {
        mesh.colored_vertex(point, tint.to_color32());
    }
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(0, 2, 3);
    Shape::mesh(mesh)
}

/// The complete card material as a shape list (shadows → fill → border → rim → glow), ready
/// to be inserted at a reserved slot behind the card's content.
pub fn card_shapes(rect: Rect, spec: &ThemeSpec) -> Vec<Shape> {
    let tokens = spec.tokens;
    let radius = spec.radius;
    let corner = CornerRadius::same(radius.round().clamp(0.0, 255.0) as u8);
    let profile = spec.shadow;
    let mut shapes = Vec::new();

    if let Some([dx, dy, blur]) = profile.card_light {
        if tokens.shadow_c2.a > 0.002 {
            shapes.extend(soft_shadow_shapes(
                rect,
                radius,
                Vec2::new(dx, dy),
                blur,
                tokens.shadow_c2,
            ));
        }
    }
    let [dx, dy, blur] = profile.card_dark;
    shapes.extend(soft_shadow_shapes(
        rect,
        radius,
        Vec2::new(dx, dy),
        blur,
        tokens.shadow_c1,
    ));

    shapes.push(Shape::rect_filled(rect, corner, tokens.panel.to_color32()));
    shapes.push(Shape::rect_stroke(
        rect,
        corner,
        Stroke::new(1.0, tokens.border.to_color32()),
        StrokeKind::Inside,
    ));

    if profile.card_rim {
        shapes.push(top_rim_shape(rect.shrink(0.75), radius, tokens.edge_hi));
        let glow = Rect::from_min_max(
            Pos2::new(rect.min.x + 6.0, rect.max.y - 12.0),
            Pos2::new(rect.max.x - 6.0, rect.max.y - 1.0),
        );
        shapes.push(vertical_glow_shape(glow, tokens.edge_lo.scale_alpha(3.0)));
    }
    shapes
}



/// Painter-level state of a gummy button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonKind {
    Normal,
    Primary,
    Danger,
    Armed,
    Ghost,
}

/// Paint a gummy button. `hover_t` / `press_t` are animated 0..1 progress values (the shell
/// feeds them from egui's `animate_bool_with_time`); lift and sink are shaped by the CSS
/// `--spring` curve so the motion matches the Web reference. `rect` is the resting rectangle.
pub fn paint_button(
    painter: &egui::Painter,
    rect: Rect,
    radius: f32,
    spec: &ThemeSpec,
    kind: ButtonKind,
    hover_t: f32,
    press_t: f32,
    enabled: bool,
) {
    let tokens = spec.tokens;
    let corner = CornerRadius::same(radius.round().clamp(0.0, 255.0) as u8);
    let hover_t = if enabled { hover_t.clamp(0.0, 1.0) } else { 0.0 };
    let press_t = if enabled { press_t.clamp(0.0, 1.0) } else { 0.0 };
    let hover_ease = super::motion::spring(hover_t);
    let press_ease = super::motion::spring(press_t);
    // `.btn:hover { transform: translateY(-1px) }` / `:active { translateY(2px) scale(.96) }`
    let lift = -hover_ease * (1.0 - press_t) + 2.0 * press_ease;
    let mut rect = rect.translate(Vec2::new(0.0, lift));
    if press_t > 0.0 {
        let scale = 1.0 - 0.04 * press_ease;
        rect = Rect::from_center_size(rect.center(), rect.size() * scale);
    }
    let brightness = if enabled {
        1.0 + 0.045 * hover_ease - 0.01 * press_ease
    } else {
        0.8
    };
    let sunken = press_t > 0.02;

    // Outer elevation (dropped while pressed — the light moves inside the button).
    if enabled && !sunken {
        let profile = spec.shadow;
        if let Some([dx, dy, blur]) = profile.button_light {
            paint_soft_shadow(
                painter,
                rect,
                radius,
                Vec2::new(dx, dy),
                blur,
                tokens.shadow_c2,
            );
        }
        let [dx, dy, blur] = profile.button_dark;
        let shadow = match kind {
            ButtonKind::Primary | ButtonKind::Danger | ButtonKind::Armed => tokens.accent_shadow,
            _ => tokens.shadow_c1,
        };
        paint_soft_shadow(painter, rect, radius, Vec2::new(dx, dy), blur, shadow);
    }

    // Fill.
    let (top, bottom) = match kind {
        ButtonKind::Normal => (
            Rgba::rgb(255, 255, 255)
                .with_alpha(spec.button.top_alpha)
                .gamma_scale(brightness),
            tokens.chip.gamma_scale(brightness),
        ),
        ButtonKind::Ghost => (tokens.glass_weak, tokens.glass_weak),
        ButtonKind::Primary => (tokens.accent.gamma_scale(brightness), tokens.accent_2.gamma_scale(brightness)),
        ButtonKind::Danger => (tokens.err.gamma_scale(brightness), tokens.err_2.gamma_scale(brightness)),
        ButtonKind::Armed => (tokens.warn.gamma_scale(brightness), tokens.warn_2.gamma_scale(brightness)),
    };
    fill_rounded_gradient(painter, rect, radius, top, bottom, 145.0);

    // Border for ghost buttons (they are translucent by design).
    if kind == ButtonKind::Ghost {
        painter.rect_stroke(
            rect,
            corner,
            Stroke::new(1.0, tokens.border_soft.to_color32()),
            StrokeKind::Inside,
        );
    }

    if sunken {
        // `inset 4px 5px 11px` dark + light inset — approximated with two inner strokes.
        painter.rect_stroke(
            rect.shrink(0.5),
            corner,
            Stroke::new(2.5, tokens.shadow_c1.scale_alpha(0.55).to_color32()),
            StrokeKind::Inside,
        );
        painter.rect_stroke(
            rect.shrink(2.5),
            corner,
            Stroke::new(1.5, tokens.shadow_c2.scale_alpha(0.5).to_color32()),
            StrokeKind::Inside,
        );
    } else if spec.shadow.card_rim {
        // `inset 0 1.5px 0` top rim. Primary/danger/armed carry their own lighter rim.
        // 这圈描边被裁到上半部后，圆角处会露出一截白色弧线——它只属于糖玻璃（GUMMY）
        // 主题的"高光"语言；哑光主题（card_rim=false，如纸面）整条跳过，否则弧线在
        // 浅色底上会被当成脏东西（Owner 截图 bug）。
        let rim = match kind {
            ButtonKind::Primary | ButtonKind::Danger | ButtonKind::Armed => {
                Rgba::rgb(255, 255, 255).with_alpha(0.35)
            }
            _ => tokens.edge_hi,
        };
        let upper = Rect::from_min_max(rect.min, Pos2::new(rect.max.x, rect.center().y));
        painter
            .with_clip_rect(upper.intersect(painter.clip_rect()))
            .rect_stroke(
                rect.shrink(0.75),
                corner,
                Stroke::new(1.25, rim.to_color32()),
                StrokeKind::Inside,
            );
    }
}

/// Inset "well" shadows of inputs and dropdown triggers
/// (`inset 3px 4px 10px` dark + `inset -3px -4px 9px` light shadows). Returned as shapes so
/// the caller can layer them over the well fill but under the content.
pub fn well_inset_shapes(rect: Rect, radius: f32, spec: &ThemeSpec) -> Vec<Shape> {
    let tokens = spec.tokens;
    let mut shapes = soft_shadow_shapes(
        rect.translate(Vec2::new(3.0, 4.0)).shrink(2.0),
        radius,
        Vec2::ZERO,
        9.0,
        tokens.shadow_c1.scale_alpha(0.8),
    );
    shapes.extend(soft_shadow_shapes(
        rect.translate(Vec2::new(-3.0, -4.0)).shrink(2.0),
        radius,
        Vec2::ZERO,
        8.0,
        tokens.shadow_c2.scale_alpha(0.7),
    ));
    shapes
}

/// Two-stop linear gradient fill, drawn as a four-corner mesh. Exact for two stops because
/// barycentric interpolation of a linear function is linear.
pub fn fill_linear_gradient(
    painter: &egui::Painter,
    rect: Rect,
    from: Rgba,
    to: Rgba,
    angle_deg: f32,
) {
    let (dir, span, center) = gradient_span(rect, angle_deg);
    let corners = [
        rect.left_top(),
        rect.right_top(),
        rect.right_bottom(),
        rect.left_bottom(),
    ];
    let mut mesh = Mesh::default();
    for point in corners {
        let t = ((point - center).dot(dir) / span + 0.5).clamp(0.0, 1.0);
        mesh.colored_vertex(point, from.lerp(to, t).to_color32());
    }
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(0, 2, 3);
    painter.add(Shape::mesh(mesh));
}

/// 圆角矩形内的线性渐变填充：沿圆角矩形轮廓采样 64 点，自中心扇形三角化，
/// 顶点色按渐变轴投影计算。egui 的矩形 mesh 不会裁圆角——这正是此前
/// "选择框直角、预选框圆角"（Owner 反馈）的根源：rect_filled 走圆角，
/// fill_linear_gradient 不走。
pub fn fill_rounded_gradient(
    painter: &egui::Painter,
    rect: Rect,
    radius: f32,
    from: Rgba,
    to: Rgba,
    angle_deg: f32,
) {
    let (dir, span, center) = gradient_span(rect, angle_deg);
    let gradient_at = |point: Pos2| -> Color32 {
        let t = ((point - center).dot(dir) / span + 0.5).clamp(0.0, 1.0);
        from.lerp(to, t).to_color32()
    };
    let r = radius.clamp(0.0, rect.width().min(rect.height()) / 2.0);
    let mut points: Vec<Pos2> = Vec::with_capacity(64);
    // 四条直边 + 四段 90° 圆弧，逐角采样。
    let corners = [
        (rect.right() - r, rect.top() + r, 0.0_f32),
        (rect.right() - r, rect.bottom() - r, 1.0),
        (rect.left() + r, rect.bottom() - r, 2.0),
        (rect.left() + r, rect.top() + r, 3.0),
    ];
    for (cx, cy, quadrant) in corners {
        let base_angle = match quadrant {
            0.0 => -90.0_f32,
            1.0 => 0.0,
            2.0 => 90.0,
            _ => 180.0,
        };
        for step in 0..=8 {
            let a = (base_angle + 90.0 * step as f32 / 8.0).to_radians();
            points.push(Pos2::new(cx + a.cos() * r, cy + a.sin() * r));
        }
    }
    let center_point = rect.center();
    let mut mesh = Mesh::default();
    let center_index = mesh.vertices.len() as u32;
    mesh.colored_vertex(center_point, gradient_at(center_point));
    for (index, point) in points.iter().enumerate() {
        mesh.colored_vertex(*point, gradient_at(*point));
        let a = center_index;
        let b = center_index + 1 + index as u32;
        let c = center_index + 1 + ((index + 1) % points.len()) as u32;
        mesh.add_triangle(a, b, c);
    }
    painter.add(Shape::mesh(mesh));
}

/// 主题过渡安全的两色混合：进度 t 时取插值色。
pub fn blend(from: Rgba, to: Rgba, t: f32) -> Color32 {
    from.lerp(to, t).to_color32()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::themes;

    #[test]
    fn disc_profiles_stay_in_unit_range_and_are_monotonic() {
        for profile in [DiscProfile::Linear, DiscProfile::Soft] {
            let mut previous = disc_alpha(profile, 0.0);
            assert!((previous - 1.0).abs() < 1e-6);
            for step in 1..=64 {
                let u = step as f32 / 64.0;
                let alpha = disc_alpha(profile, u);
                assert!((0.0..=1.0).contains(&alpha), "alpha escaped range");
                assert!(alpha <= previous + 1e-6, "alpha must not rise with radius");
                previous = alpha;
            }
            assert_eq!(disc_alpha(profile, 1.0), 0.0);
        }
    }

    #[test]
    fn css_gradient_direction_points_down_right_at_130_degrees() {
        let dir = gradient_direction(130.0);
        assert!(dir.x > 0.0 && dir.y > 0.0, "130° must aim right and down");
        assert!((dir.length() - 1.0).abs() < 1e-5);
        let up = gradient_direction(0.0);
        assert!(up.y < 0.0 && up.x.abs() < 1e-6, "0° must aim up");
    }

    #[test]
    fn strip_boundaries_and_colors_are_well_formed() {
        let boundaries = gradient_boundaries(32);
        assert_eq!(boundaries.len(), 33);
        assert_eq!(boundaries[0], 0.0);
        assert_eq!(*boundaries.last().expect("last"), 1.0);
        assert!(boundaries.windows(2).all(|pair| pair[1] > pair[0]));
        for spec in themes::all() {
            let colors = gradient_strip_colors(&spec.background, &boundaries);
            assert_eq!(colors.len(), boundaries.len());
            assert!(colors.iter().all(|color| color.is_finite()));
        }
    }

    #[test]
    fn gradient_span_is_positive_for_all_themes_and_sizes() {
        let rect = Rect::from_min_size(Pos2::new(0.0, 0.0), Vec2::new(1280.0, 800.0));
        for spec in themes::all() {
            let (_, span, _) = gradient_span(rect, spec.background.gradient_angle);
            assert!(span.is_finite() && span > 0.0);
        }
        let degenerate = Rect::from_min_size(Pos2::new(10.0, 10.0), Vec2::ZERO);
        let (_, span, _) = gradient_span(degenerate, 130.0);
        assert!(span > 0.0, "degenerate rects must not divide by zero");
    }
}
