//! Motion recipes: easing math and the timed states behind theme switching, blob drift,
//! page enter and the theme-switch ripple.
//!
//! Everything here is pure math over `Instant` timestamps so the behaviours stay testable
//! without a window. The Web reference uses `--spring: cubic-bezier(.3, 1.6, .5, 1)` for
//! hover/press, `cubic-bezier(.22, .8, .25, 1)` for page-entry fades, and a 1500 ms
//! “once” ripple when the theme background changes (`design-demos/bg-ripple/README.md`).

use std::time::{Duration, Instant};

/// Evaluate a CSS cubic-bezier easing curve at `t` (0..=1, clamped).
/// Control points are `(x1, y1, x2, y2)`; `y` may overshoot 1.0 (the spring does).
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    // Solve x(s) = t for s with a fixed number of Newton steps + bisection fallback.
    fn bezier(a: f32, b: f32, s: f32) -> f32 {
        let inv = 1.0 - s;
        3.0 * inv * inv * s * a + 3.0 * inv * s * s * b + s * s * s
    }
    fn bezier_derivative(a: f32, b: f32, s: f32) -> f32 {
        let inv = 1.0 - s;
        3.0 * inv * inv * a + 6.0 * inv * s * (b - a) + 3.0 * s * s * (1.0 - b)
    }
    let mut s = t;
    for _ in 0..8 {
        let x = bezier(x1, x2, s) - t;
        if x.abs() < 1e-5 {
            break;
        }
        let d = bezier_derivative(x1, x2, s);
        if d.abs() < 1e-6 {
            break;
        }
        s = (s - x / d).clamp(0.0, 1.0);
    }
    bezier(y1, y2, s)
}

/// `--spring` — the hover/press lift curve. Overshoots above 1 mid-way, settles at 1.
pub fn spring(t: f32) -> f32 {
    cubic_bezier(0.3, 1.6, 0.5, 1.0, t)
}

/// Page-entry fade curve — `cubic-bezier(.22, .8, .25, 1)`.
pub fn enter_ease(t: f32) -> f32 {
    cubic_bezier(0.22, 0.8, 0.25, 1.0, t)
}

/// Smooth in-out for colour cross-fades (C1-continuous, no overshoot on colours).
pub fn cross_fade(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Timed progress of a one-shot animation.
#[derive(Clone, Copy, Debug)]
pub struct Timed {
    started: Option<Instant>,
    duration: Duration,
}

impl Timed {
    pub const fn idle() -> Self {
        Self {
            started: None,
            duration: Duration::from_millis(1),
        }
    }

    /// Start (or restart) the animation with a duration in milliseconds.
    pub fn start(&mut self, now: Instant, duration_ms: u32) {
        self.started = Some(now);
        self.duration = Duration::from_millis(u64::from(duration_ms.max(1)));
    }

    pub fn finish(&mut self) {
        self.started = None;
    }

    pub const fn is_active(&self) -> bool {
        self.started.is_some()
    }

    /// Linear progress 0..=1; 1.0 when idle.
    pub fn progress(&self, now: Instant) -> f32 {
        match self.started {
            None => 1.0,
            Some(started) => {
                let elapsed = now.saturating_duration_since(started).as_secs_f32();
                let total = self.duration.as_secs_f32();
                (elapsed / total).clamp(0.0, 1.0)
            }
        }
    }

    /// Eased progress; the animation clears itself once it reaches the end.
    pub fn sample(&mut self, now: Instant) -> f32 {
        let progress = self.progress(now);
        if progress >= 1.0 {
            self.finish();
        }
        progress
    }
}

/// Reduce Motion preference — defined with the other UI preferences and persisted there;
/// re-exported here so motion call sites only need this module.
pub use crate::ui_prefs::ReduceMotion;

/// Motion timing after Reduce Motion collapses it. Reduced motion keeps a short cross-fade
/// (visible state change, no travel) and drops decorative motion entirely.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionBudget {
    pub reduce_motion: bool,
}

impl MotionBudget {
    pub const fn full() -> Self {
        Self {
            reduce_motion: false,
        }
    }

    pub const fn reduced() -> Self {
        Self {
            reduce_motion: true,
        }
    }

    /// Theme cross-fade duration: 700 ms full, 150 ms fade under Reduce Motion.
    pub fn theme_transition_ms(&self, spec_ms: u32) -> u32 {
        if self.reduce_motion { 150 } else { spec_ms }
    }

    /// Page enter: 340 ms rise+fade full, 120 ms fade only when reduced.
    pub fn page_enter_ms(&self, spec_ms: u32) -> u32 {
        if self.reduce_motion { 120 } else { spec_ms }
    }

    /// Ripple plays only when motion is allowed — Reduce Motion drops it completely.
    pub fn ripple_enabled(&self) -> bool {
        !self.reduce_motion
    }

    /// Blob drift only runs with full motion.
    pub fn drift_enabled(&self) -> bool {
        !self.reduce_motion
    }

    /// Page-enter vertical rise in logical pixels (0 under Reduce Motion).
    pub fn page_enter_rise(&self) -> f32 {
        if self.reduce_motion { 0.0 } else { 12.0 }
    }
}

/// Slow drift of the three ambient blobs. Offsets are sinusoidal, stay inside the spec
/// amplitude, and use different phases per blob so the layer breathes instead of sliding.
pub fn blob_drift_offset(phase: f32, index: usize, amplitude: [f32; 2]) -> [f32; 2] {
    let seed = index as f32 * 2.399_963; // golden-angle phase spread
    [
        (phase + seed).sin() * amplitude[0],
        (phase * 0.7 + seed * 1.3).cos() * amplitude[1],
    ]
}

/// One ripple ring at animation time `t` (0..=1, linear).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RippleRing {
    /// Ring radius as a viewport fraction of the distance origin→far corner.
    pub radius: f32,
    /// Stroke alpha multiplier, 0..=1.
    pub alpha: f32,
}

/// Ring positions of the theme-switch ripple. `t` is linear progress 0..=1.
///
/// The Web source (“涟漪原波”, `design-demos/bg-ripple/`) expands a wavefront from the
/// bottom-right corner while concentric rings trail it at 0.85× the wave speed and decay
/// with distance. This is the lightweight native reading: `rings` expanding circles whose
/// radii tile the full span, with the leading ring at full alpha and decays behind it.
pub fn ripple_rings(t: f32, rings: u32) -> Vec<RippleRing> {
    let t = t.clamp(0.0, 1.0);
    let rings = rings.max(1);
    let mut out = Vec::with_capacity(rings as usize);
    for i in 0..rings {
        let offset = i as f32 / rings as f32;
        // Each ring sweeps the full span slightly behind the wavefront.
        let radius = (t * 1.15 - offset * 0.35).clamp(0.0, 1.45);
        if radius <= 0.0 {
            continue;
        }
        // Fade in fast, decay with distance; the whole layer also fades as `t` closes.
        let head = (1.0 - offset).powi(2);
        let envelope = (1.0 - t).powf(0.85);
        let alpha = (0.16 * head * envelope).clamp(0.0, 0.16);
        out.push(RippleRing { radius, alpha });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bezier_curves_hit_their_endpoints_and_stay_finite() {
        for (name, f) in [
            ("spring", spring as fn(f32) -> f32),
            ("enter", enter_ease as fn(f32) -> f32),
            ("fade", cross_fade as fn(f32) -> f32),
        ] {
            assert!(f(0.0).abs() < 1e-3, "{name} must start at 0");
            assert!((f(1.0) - 1.0).abs() < 1e-3, "{name} must end at 1");
            for step in 0..=20 {
                let value = f(step as f32 / 20.0);
                assert!(value.is_finite(), "{name} produced a non-finite value");
                assert!((-0.5..=1.8).contains(&value), "{name} out of range: {value}");
            }
        }
    }

    #[test]
    fn spring_overshoots_but_settles() {
        let peak = (0..=100)
            .map(|i| spring(i as f32 / 100.0))
            .fold(f32::MIN, f32::max);
        assert!(peak > 1.0, "the spring should overshoot");
        assert!(peak < 1.35, "the spring overshoot should stay subtle");
    }

    #[test]
    fn timed_animations_report_progress_and_self_clear() {
        let now = Instant::now();
        let mut timed = Timed::idle();
        assert!(!timed.is_active());
        assert_eq!(timed.progress(now), 1.0);
        timed.start(now, 700);
        assert!(timed.is_active());
        assert!(timed.progress(now) < 0.1);
        let later = now + Duration::from_millis(2_000);
        assert_eq!(timed.sample(later), 1.0);
        assert!(!timed.is_active(), "finished animations must clear");
    }

    #[test]
    fn reduce_motion_collapses_every_motion_channel() {
        let full = MotionBudget::full();
        let reduced = MotionBudget::reduced();
        assert_eq!(full.theme_transition_ms(700), 700);
        assert_eq!(reduced.theme_transition_ms(700), 150);
        assert_eq!(reduced.page_enter_ms(340), 120);
        assert!(full.ripple_enabled() && full.drift_enabled());
        assert!(!reduced.ripple_enabled() && !reduced.drift_enabled());
        assert_eq!(reduced.page_enter_rise(), 0.0);
        assert!(full.page_enter_rise() > 0.0);
        assert!(ReduceMotion::Auto.resolve(true));
        assert!(!ReduceMotion::Auto.resolve(false));
        assert!(ReduceMotion::On.resolve(false));
        assert!(!ReduceMotion::Off.resolve(true));
        assert_eq!(ReduceMotion::parse("REDUCE"), Some(ReduceMotion::On));
        assert_eq!(ReduceMotion::parse("bogus"), None);
    }

    #[test]
    fn drift_stays_inside_the_configured_amplitude() {
        let amplitude = [0.016, 0.020];
        let mut min = [f32::MAX; 2];
        let mut max = [f32::MIN; 2];
        for step in 0..2_000 {
            let phase = step as f32 * 0.01;
            for index in 0..3 {
                let offset = blob_drift_offset(phase, index, amplitude);
                for axis in 0..2 {
                    assert!(offset[axis].is_finite());
                    assert!(
                        offset[axis].abs() <= amplitude[axis] + 1e-6,
                        "drift escaped its amplitude"
                    );
                    min[axis] = min[axis].min(offset[axis]);
                    max[axis] = max[axis].max(offset[axis]);
                }
            }
        }
        // The drift must actually move (otherwise it is dead code), on both axes.
        for axis in 0..2 {
            assert!(max[axis] - min[axis] > amplitude[axis] * 1.5);
        }
    }

    #[test]
    fn ripple_rings_expand_and_fade_without_nan() {
        let rings = ripple_rings(0.0, 11);
        assert!(rings.is_empty() || rings.iter().all(|ring| ring.radius >= 0.0));
        let mid = ripple_rings(0.5, 11);
        assert!(!mid.is_empty());
        assert!(mid.iter().all(|ring| ring.alpha > 0.0 && ring.alpha <= 0.16));
        assert!(mid.iter().all(|ring| ring.radius.is_finite()));
        // Head ring leads the trail.
        assert!(mid[0].radius >= mid[mid.len() - 1].radius - 1e-6);
        let late = ripple_rings(1.0, 11);
        assert!(late.iter().all(|ring| ring.alpha < 1e-3), "ripple must end clean");
        // Monotonic head growth across the animation.
        let a = ripple_rings(0.25, 11)[0].radius;
        let b = ripple_rings(0.75, 11)[0].radius;
        assert!(b >= a);
    }
}
