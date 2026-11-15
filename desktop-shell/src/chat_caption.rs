//! Small DWM caption adapter. Window styles and system caption buttons stay native.
//! This is a presentation mirror only; React owns the selected page/chat mode.
use std::ptr::{null, null_mut};
use std::cell::{Cell, RefCell};
use windows_sys::Win32::Graphics::GdiPlus as gp;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus, GetKeyState, TrackMouseEvent, TRACKMOUSEEVENT, TME_LEAVE, TME_NONCLIENT, VK_LEFT, VK_RIGHT, VK_HOME, VK_END, VK_TAB, VK_SHIFT, VK_RETURN};
use windows_sys::{core::w, Win32::{Foundation::*, Graphics::{Dwm::*, Gdi::*}, UI::{Controls::{DRAWITEMSTRUCT, ODS_FOCUS, MARGINS, BeginBufferedPaint, BufferedPaintInit, BufferedPaintUnInit, BufferedPaintSetAlpha, EndBufferedPaint, BPBF_TOPDOWNDIB}, HiDpi::*, Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass}, WindowsAndMessaging::*}}};

const SUBCLASS: usize = 0x434d4341;
const FIRST_ID: usize = 0x7010;
const LABELS: [&str; 3] = ["普通聊天", "仿真聊天", "项目协作"];
const PROPERTY: *const u16 = w!("CetaMesh.ChatCaption");
const CAPTION_HEIGHT: i32 = 40;
const MODE_HEIGHT: i32 = 30;
const WINDOW_CONTROL_WIDTH: i32 = 32;
const WINDOW_CONTROL_HEIGHT: i32 = 28;
const CAPTION_GUTTER: i32 = 14;
const SYSTEM_CONTROLS: [(usize, u32); 3] = [(2, HTMINBUTTON), (3, HTMAXBUTTON), (5, HTCLOSE)];

#[derive(Clone, Copy)]
struct CaptionColors {
    background: u32,
    track: u32,
    selected: u32,
    text: u32,
    muted: u32,
    accent: u32,
    hover: u32,
}

// One native antialiased shape helper; text remains ClearType-rendered by GDI.
unsafe fn rounded(dc: HDC, rect: RECT, radius: i32, fill: Option<u32>, stroke: Option<(u32, f32)>) { unsafe {
    let argb = |color: u32| 0xff000000 | ((color & 255) << 16) | (color & 0xff00) | ((color >> 16) & 255);
    let mut graphics = null_mut(); let mut path = null_mut();
    if gp::GdipCreateFromHDC(dc, &mut graphics) != gp::Ok { return; }
    if gp::GdipCreatePath(gp::FillModeAlternate, &mut path) != gp::Ok { gp::GdipDeleteGraphics(graphics); return; }
    gp::GdipSetSmoothingMode(graphics, gp::SmoothingModeAntiAlias);
    let x = rect.left as f32 + 0.5; let y = rect.top as f32 + 0.5;
    let width = (rect.right - rect.left - 1) as f32; let height = (rect.bottom - rect.top - 1) as f32;
    let diameter = (radius * 2) as f32; let diameter = diameter.min(width).min(height).max(1.0);
    for (ax, ay, angle) in [(x, y, 180.0), (x+width-diameter, y, 270.0), (x+width-diameter, y+height-diameter, 0.0), (x, y+height-diameter, 90.0)] {
        gp::GdipAddPathArc(path, ax, ay, diameter, diameter, angle, 90.0);
    }
    gp::GdipClosePathFigure(path);
    if let Some(color) = fill {
        let mut brush = null_mut();
        if gp::GdipCreateSolidFill(argb(color), &mut brush) == gp::Ok { gp::GdipFillPath(graphics, brush.cast(), path); gp::GdipDeleteBrush(brush.cast()); }
    }
    if let Some((color, width)) = stroke {
        let mut pen = null_mut();
        if gp::GdipCreatePen1(argb(color), width, gp::UnitPixel, &mut pen) == gp::Ok { gp::GdipDrawPath(graphics, pen, path); gp::GdipDeletePen(pen); }
    }
    gp::GdipDeletePath(path); gp::GdipDeleteGraphics(graphics);
} }

/// Native regression: inspect composed caption pixels and OS-owned input geometry.
#[cfg(debug_assertions)]
pub fn check_native_buttons(hwnd: HWND) -> Result<(), String> { unsafe {
    if height(hwnd) - insets(hwnd).top != scale(hwnd, CAPTION_HEIGHT) {
        return Err(format!("caption must reserve {CAPTION_HEIGHT} logical pixels"));
    }
    let mut outer = RECT::default(); GetWindowRect(hwnd, &mut outer);
    if IsZoomed(hwnd) == 0 {
        let mut client = RECT::default(); GetClientRect(hwnd, &mut client);
        let inset = insets(hwnd);
        if inset.right <= 0 || inset.right > scale(hwnd, 3) || inset.bottom != inset.right {
            return Err("normal window must retain a slim native resize gutter".into());
        }
        for (point, expected) in [
            (POINT { x: 1, y: client.bottom / 2 }, HTLEFT),
            (POINT { x: client.right - 2, y: client.bottom / 2 }, HTRIGHT),
            (POINT { x: client.right / 2, y: client.bottom - 2 }, HTBOTTOM),
        ] {
            // Sending WM_NCHITTEST directly to the parent misses a child WebView
            // swallowing the real mouse target. Verify both ownership and result.
            if ChildWindowFromPointEx(hwnd, point, CWP_SKIPINVISIBLE) != hwnd {
                return Err("WebView child covers native resize edge".into());
            }
            let mut screen = point; ClientToScreen(hwnd, &mut screen);
            let hit = SendMessageW(hwnd, WM_NCHITTEST, 0,
                ((screen.y as u32 & 0xffff) << 16 | (screen.x as u32 & 0xffff)) as isize);
            if hit != expected as isize { return Err("native resize edge hit test failed".into()); }
        }
        check_caption_edge_pixels(hwnd, client)?;
    }
    let info = titlebar_info(hwnd);
    let inset = insets(hwnd);
    let frame = RECT { left: outer.left + inset.left, top: outer.top + inset.top,
        right: outer.right - inset.right, bottom: outer.top + height(hwnd) };
    let drag = POINT { x: frame.left + scale(hwnd, 160), y: frame.bottom - scale(hwnd, 2) };
    let hit = SendMessageW(hwnd, WM_NCHITTEST, 0,
        ((drag.y as u32 & 0xffff) << 16 | (drag.x as u32 & 0xffff)) as isize);
    if WindowFromPoint(drag) != hwnd || hit != HTCAPTION as isize {
        return Err("compact caption drag strip is unreachable".into());
    }
    let geometry = caption_geometry(hwnd, frame, SYSTEM_CONTROLS.map(|(index, _)| info.rgrect[index]));
    let expected_center = frame.top + (frame.bottom-frame.top)/2;
    if geometry.center_y.abs_diff(expected_center) > 1 {
        return Err(format!("caption row is above its visible midpoint: center={} expected={expected_center} frame_top={} frame_bottom={} native_button_bottom={} dpi={}",
            geometry.center_y, frame.top, frame.bottom, info.rgrect[3].bottom, GetDpiForWindow(hwnd)));
    }
    let mut dwm = RECT::default();
    let hr = DwmGetWindowAttribute(hwnd, DWMWA_CAPTION_BUTTON_BOUNDS as u32, (&mut dwm as *mut RECT).cast(), std::mem::size_of::<RECT>() as u32);
    if let Some(path) = std::env::var_os("CETAMESH_CAPTION_BOUNDS_TRACE") {
        use std::io::Write;
        let mut visible = RECT::default();
        DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, (&mut visible as *mut RECT).cast(), std::mem::size_of::<RECT>() as u32);
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "maximized={} outer=[{},{},{},{}] visible=[{},{},{},{}]", IsZoomed(hwnd), outer.left, outer.top, outer.right, outer.bottom, visible.left, visible.top, visible.right, visible.bottom);
        }
    }
    let dx = outer.left + (dwm.left + dwm.right) / 2;
    let dy = outer.top + (dwm.top + dwm.bottom) / 2;
    let dwm_hit = SendMessageW(hwnd, WM_NCHITTEST, 0, ((dy as u32 & 0xffff) << 16 | (dx as u32 & 0xffff)) as isize);
    let content_center = geometry.center_y;
    for ((index, expected), visual) in SYSTEM_CONTROLS.into_iter().zip(geometry.controls) {
        let rect = info.rgrect[index];
        let x = (rect.left + rect.right) / 2; let y = (rect.top + rect.bottom) / 2;
        let hit = SendMessageW(hwnd, WM_NCHITTEST, 0, ((y as u32 & 0xffff) << 16 | (x as u32 & 0xffff)) as isize);
        if rect.right <= rect.left || rect.top < outer.top || rect.bottom > outer.bottom || hit != expected as isize {
            return Err(format!("caption={index} outer=[{},{},{},{}] button=[{},{},{},{}] hit={hit} expected={expected} dwm_hr={hr} dwm=[{},{},{},{}] dwm_center_hit={dwm_hit} dpi={}", outer.left, outer.top, outer.right, outer.bottom, rect.left, rect.top, rect.right, rect.bottom, dwm.left, dwm.top, dwm.right, dwm.bottom, GetDpiForWindow(hwnd)));
        }
        let visual = visual.ok_or("empty caption control")?;
        let visual_x = (visual.left + visual.right) / 2;
        let visual_center = (visual.top + visual.bottom) / 2;
        let visual_hit = SendMessageW(hwnd, WM_NCHITTEST, 0,
            ((visual_center as u32 & 0xffff) << 16 | (visual_x as u32 & 0xffff)) as isize);
        if visual_center.abs_diff(content_center) > 1 || visual_hit != expected as isize
            || visual.left < rect.left || visual.right > rect.right || visual.top < frame.top || visual.bottom > frame.bottom {
            return Err(format!("caption={index} visual center={visual_center} row center={content_center} hit={visual_hit} expected={expected} dpi={}", GetDpiForWindow(hwnd)));
        }
        // The visible face may extend below the stock DWM caption. Every edge
        // must still return the native command, including HTMAXBUTTON for Snap.
        for point in [POINT { x: visual_x, y: visual.top+1 }, POINT { x: visual_x, y: visual.bottom-2 },
            POINT { x: visual.left+1, y: visual_center }, POINT { x: visual.right-2, y: visual_center }] {
            let hit = SendMessageW(hwnd, WM_NCHITTEST, 0,
                ((point.y as u32 & 0xffff) << 16 | (point.x as u32 & 0xffff)) as isize);
            if WindowFromPoint(point) != hwnd || hit != expected as isize {
                return Err(format!("caption={index} visible edge=({}, {}) hit={hit} expected={expected}", point.x, point.y));
            }
        }
    }
    let [Some(minimize), Some(maximize), Some(close)] = geometry.controls else { return Err("missing caption control".into()); };
    let width = minimize.right - minimize.left;
    if geometry.gutter.abs_diff(frame.right - close.right) > 1
        || width != maximize.right - maximize.left || width != close.right - close.left
        || (maximize.left - minimize.right).abs_diff(close.left - maximize.right) > 1 {
        return Err("asymmetric caption gutters or window controls".into());
    }
    if IsZoomed(hwnd) != 0 {
        let mut monitor = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut monitor);
        let mut button = RECT::default(); GetWindowRect(GetDlgItem(hwnd, FIRST_ID as i32), &mut button);
        if button.top < monitor.rcWork.top || button.left < monitor.rcWork.left || button.right > monitor.rcWork.right {
            return Err(format!("custom caption clipped: top={} work_top={} left={} right={}", button.top, monitor.rcWork.top, button.left, button.right));
        }
    }
    let visible: Vec<HWND> = (0..4).map(|index| GetDlgItem(hwnd, (FIRST_ID + index) as i32))
        .filter(|button| IsWindowVisible(*button) != 0).collect();
    for button in &visible {
        let mut bounds = RECT::default(); GetWindowRect(*button, &mut bounds);
        if (bounds.top + bounds.bottom).abs_diff(2 * content_center) > 2
            || bounds.bottom - bounds.top != scale(hwnd, MODE_HEIGHT) {
            return Err(format!("mode control misses the compact caption row: top={} bottom={} center={content_center} dpi={}",
                bounds.top, bounds.bottom, GetDpiForWindow(hwnd)));
        }
        let buttons_left = info.rgrect[2].left;
        if bounds.left < outer.left + scale(hwnd, 204) || bounds.right > buttons_left - scale(hwnd, 12)
            || bounds.bottom > outer.top + height(hwnd) || bounds.top < outer.top + insets(hwnd).top {
            return Err("mode control overlaps brand, system buttons or caption bounds".into());
        }
    }
    if let Some(first) = visible.first() {
        let mut first_bounds = RECT::default(); let mut last_bounds = RECT::default();
        GetWindowRect(*first, &mut first_bounds);
        GetWindowRect(*visible.last().unwrap(), &mut last_bounds);
        if (first_bounds.left + last_bounds.right).abs_diff(frame.left + frame.right) > 1 {
            return Err("chat modes are not centered in the visible caption".into());
        }
        SetFocus(*first); SendMessageW(*first, WM_KEYDOWN, VK_RIGHT as usize, 0);
        if GetFocus() != visible[usize::from(visible.len() > 1)] { return Err("caption arrow-key navigation failed".into()); }
    }
    Ok(())
} }

#[cfg(debug_assertions)]
unsafe fn check_caption_edge_pixels(hwnd: HWND, client: RECT) -> Result<(), String> { unsafe {
    let inset = insets(hwnd);
    let y = height(hwnd) / 2;
    // Maximized resize edges are intentionally outside the monitor work area;
    // sample the visible caption there, while still covering edge slivers in
    // restored windows. Off-screen GetPixel returns CLR_INVALID, not a color.
    let xs = if IsZoomed(hwnd)!=0 { [inset.left+1,inset.left+scale(hwnd,160),client.right-inset.right-2] }
        else { [inset.left/2,inset.left+scale(hwnd,160),client.right-inset.right/2-1] };
    let points = xs.map(|x| {
        let mut point = POINT { x, y };
        ClientToScreen(hwnd, &mut point);
        point
    });
    UpdateWindow(hwnd);
    if DwmFlush() < 0 { return Err("caption composition did not settle".into()); }
    // Sample only the three points when the isolated caption owns them on screen.
    if points.iter().any(|point| WindowFromPoint(*point) != hwnd) {
        let mut visible = RECT::default();
        DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, (&mut visible as *mut RECT).cast(), std::mem::size_of::<RECT>() as u32);
        return Err(format!("caption pixel samples are occluded hwnd={:?} points={:?} owners={:?} visible={:?}", hwnd, points.map(|point| (point.x, point.y)), points.map(|point| WindowFromPoint(point)), (visible.left, visible.top, visible.right, visible.bottom)));
    }
    let dc = GetDC(null_mut());
    if dc.is_null() { return Err("cannot read composed caption pixels".into()); }
    let [left, background, right] = points.map(|point| GetPixel(dc, point.x, point.y));
    ReleaseDC(null_mut(), dc);
    let state = &*(GetPropW(hwnd, PROPERTY) as *const State);
    let expected = xs.map(|x|state.wallpaper_color(x,y));
    if [left, background, right] != expected {
        return Err(format!("caption background is discontinuous: expected={expected:06x?} left={left:06x} center={background:06x} right={right:06x} dpi={}", GetDpiForWindow(hwnd)));
    }
    Ok(())
} }

fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn scale(hwnd: HWND, logical: i32) -> i32 { unsafe { logical * GetDpiForWindow(hwnd).max(96) as i32 / 96 } }

fn modal_tint(color: u32, modal: bool) -> u32 {
    if !modal { return color; }
    // Match the client mask's rgba(20, 26, 21, .42) for reference close colors.
    [0, 8, 16].into_iter().fold(0, |result, shift| {
        let channel = (((color >> shift) & 255) * 58 + ((0x00151a14 >> shift) & 255) * 42 + 50) / 100;
        result | channel << shift
    })
}

struct CaptionGeometry {
    center_y: i32,
    gutter: i32,
    controls: [Option<RECT>; 3],
}

unsafe fn titlebar_info(hwnd: HWND) -> TITLEBARINFOEX { unsafe {
    let mut info = TITLEBARINFOEX::default();
    info.cbSize = std::mem::size_of::<TITLEBARINFOEX>() as u32;
    SendMessageW(hwnd, WM_GETTITLEBARINFOEX, 0, (&mut info as *mut TITLEBARINFOEX) as isize);
    info
} }

unsafe fn client_caption_geometry(hwnd: HWND, frame: RECT) -> CaptionGeometry { unsafe {
    let info = titlebar_info(hwnd);
    let hits = SYSTEM_CONTROLS.map(|(index, _)| {
        let mut rect = info.rgrect[index];
        MapWindowPoints(null_mut(), hwnd, (&mut rect as *mut RECT).cast(), 2);
        rect
    });
    caption_geometry(hwnd, frame, hits)
} }

fn caption_geometry(hwnd: HWND, frame: RECT, mut hits: [RECT; 3]) -> CaptionGeometry {
    for hit in &mut hits {
        hit.left = hit.left.max(frame.left);
        hit.right = hit.right.min(frame.right);
        hit.top = hit.top.max(frame.top);
        hit.bottom = hit.bottom.min(frame.bottom);
    }
    let valid = |rect: &RECT| rect.right > rect.left && rect.bottom > rect.top;
    let width = hits.iter().filter(|rect| valid(rect)).map(|hit| hit.right-hit.left).fold(scale(hwnd, WINDOW_CONTROL_WIDTH), i32::min);
    // The shared content row belongs to the visible custom caption. Stock DWM
    // button height must not push the brand and mode selector upward.
    let center_y = frame.top + (frame.bottom-frame.top)/2;
    let height = scale(hwnd, WINDOW_CONTROL_HEIGHT).min(frame.bottom-frame.top);

    let mut controls = hits.map(|hit| {
        if !valid(&hit) { return None; }
        let left = hit.left + (hit.right - hit.left - width) / 2;
        let top = center_y-height/2;
        Some(RECT { left, top, right: left + width, bottom: top + height })
    });

    let mut gutter = scale(hwnd, CAPTION_GUTTER);
    if let [Some(first), Some(middle), Some(last)] = &mut controls {
        middle.left = ((first.left + last.left) / 2).clamp(hits[1].left, hits[1].right - width);
        middle.right = middle.left + width;
        // The whole row may shift within its OS-owned hit areas. Mirror the actual right gutter.
        let right_gap = frame.right - last.right;
        let left_room = (first.left - hits[0].left).min(middle.left - hits[1].left).min(last.left - hits[2].left);
        let right_room = (hits[0].right - first.right).min(hits[1].right - middle.right).min(hits[2].right - last.right);
        let offset = (right_gap - gutter).clamp(-left_room, right_room);
        for control in [first, middle, last] {
            control.left += offset;
            control.right += offset;
        }
        gutter = right_gap - offset;
    }
    CaptionGeometry { center_y, gutter, controls }
}

pub fn height(hwnd: HWND) -> i32 {
    unsafe { if GetPropW(hwnd, PROPERTY).is_null() { 0 } else { scale(hwnd, CAPTION_HEIGHT) + insets(hwnd).top } }
}

/// Windows keeps its resize frame outside the monitor work area when maximized.
/// DWM still needs the full client rectangle; only our content is inset.
pub fn insets(hwnd: HWND) -> RECT { unsafe {
    if GetPropW(hwnd, PROPERTY).is_null() { return RECT::default(); }
    if IsZoomed(hwnd) == 0 {
        // Keep mouse ownership on the parent resize frame. A child WebView
        // reaching these edges intercepts input before our WM_NCHITTEST runs.
        let edge = resize_edge(hwnd).min(scale(hwnd, 3)).max(1);
        return RECT { left: edge, top: 0, right: edge, bottom: edge };
    }
    let mut outer = RECT::default(); GetWindowRect(hwnd, &mut outer);
    let mut monitor = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut monitor) == 0 { return RECT::default(); }
    RECT { left: (monitor.rcWork.left - outer.left).max(0), top: (monitor.rcWork.top - outer.top).max(0),
        right: (outer.right - monitor.rcWork.right).max(0), bottom: (outer.bottom - monitor.rcWork.bottom).max(0) }
} }

unsafe fn resize_edge(hwnd: HWND) -> i32 { unsafe {
    GetSystemMetricsForDpi(SM_CXSIZEFRAME, GetDpiForWindow(hwnd))
        + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, GetDpiForWindow(hwnd))
} }

/// Tao's decorated set_inner_size adds the standard non-client frame. A DWM
/// full-client window has no such inset; size it using its actual client bounds.
pub fn set_client_size(window: &tao::window::Window, size: tao::dpi::PhysicalSize<u32>) {
    use tao::platform::windows::WindowExtWindows;
    let hwnd = window.hwnd() as HWND;
    if height(hwnd) == 0 { window.set_inner_size(size); return; }
    unsafe { SetWindowPos(hwnd, null_mut(), 0, 0, size.width as i32, size.height as i32,
        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE); }
}

struct State {
    hwnd: HWND, buttons: [HWND; 4], font: Cell<HFONT>, selected_font: Cell<HFONT>, brand_font: Cell<HFONT>,
    selected: Cell<usize>, visible: Cell<bool>, dark: Cell<bool>,
    palette: Cell<Option<CaptionColors>>, modal: Cell<bool>,
    backdrop: RefCell<Option<crate::caption_backdrop::Bitmap>>,
    hot_control: Cell<u32>, pressed_control: Cell<bool>,
    select: Box<dyn Fn(usize)>,
}

pub struct ChatCaption { state: Box<State>, graphics_token: usize }
impl ChatCaption {
    pub fn install(hwnd: HWND, select: impl Fn(usize) + 'static) -> Result<Self, String> {
        unsafe {
            let mut original_client = RECT::default(); GetClientRect(hwnd, &mut original_client);
            let mut enabled = 0;
            if DwmIsCompositionEnabled(&mut enabled) < 0 || enabled == 0 { return Err("DWM composition unavailable".into()); }
            BufferedPaintInit();
            let mut graphics_token = 0;
            let startup = gp::GdiplusStartupInput { GdiplusVersion: 1, ..Default::default() };
            if gp::GdiplusStartup(&mut graphics_token, &startup, null_mut()) != gp::Ok { BufferedPaintUnInit(); return Err("Caption antialiasing unavailable".into()); }
            let mut result = Self { graphics_token, state: Box::new(State { hwnd, buttons: [null_mut(); 4], font: Cell::new(null_mut()), selected_font: Cell::new(null_mut()), brand_font: Cell::new(null_mut()), selected: Cell::new(0), visible: Cell::new(false), dark: Cell::new(false), palette: Cell::new(None), modal: Cell::new(false), backdrop: RefCell::new(None), hot_control: Cell::new(0), pressed_control: Cell::new(false), select: Box::new(select) }) };
            for (index, button) in result.state.buttons.iter_mut().enumerate() {
                *button = CreateWindowExW(0, w!("BUTTON"), wide(LABELS[index.min(2)]).as_ptr(), WS_CHILD | WS_TABSTOP | BS_OWNERDRAW as u32,
                    0, 0, 0, 0, hwnd, (FIRST_ID + index) as _, null_mut(), null());
                if button.is_null() { return Err("Cannot create native chat mode button".into()); }
            }
            let state = &mut *result.state as *mut State;
            for button in result.state.buttons {
                if SetWindowSubclass(button, Some(mode_button_proc), SUBCLASS, state as usize) == 0 { return Err("Cannot attach caption keyboard navigation".into()); }
            }
            if SetWindowSubclass(hwnd, Some(caption_proc), SUBCLASS, state as usize) == 0 { return Err("Cannot attach native caption".into()); }
            if SetPropW(hwnd, PROPERTY, state.cast()) == 0 { return Err("Cannot attach caption bounds".into()); }
            result.state.update_font();
            result.state.extend_frame();
            SetWindowPos(hwnd, null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            if IsZoomed(hwnd) == 0 {
                SetWindowPos(hwnd, null_mut(), 0, 0, original_client.right, original_client.bottom,
                    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
            result.state.layout();
            Ok(result)
        }
    }
    pub fn show_mode(&mut self, mode: Option<usize>) {
        self.state.visible.set(mode.is_some());
        if let Some(mode) = mode { self.state.selected.set(mode.min(2)); }
        unsafe { self.state.layout(); }
    }
    pub fn appearance(&mut self, dark: bool) {
        self.apply_appearance(dark, None, false);
    }
    pub fn appearance_palette(&mut self, dark: bool, colors: [u32; 7], modal: bool) {
        self.apply_appearance(dark, Some(CaptionColors { background: colors[0], track: colors[1], selected: colors[2], text: colors[3], muted: colors[4], accent: colors[5], hover: colors[6] }), modal);
    }
    pub fn backdrop_state(&self) -> serde_json::Value { unsafe {
        let (frame, width, height, caption_height, _) = self.state.backdrop_frame();
        serde_json::json!({"enabled":crate::caption_backdrop::enabled() && width>0 && width<=16384 && height>caption_height && height<=16384 && caption_height<=768,
            "active":self.state.backdrop.borrow().as_ref().is_some_and(|image| image.frame==frame),
            "frame":{"id":frame,"width":width,"height":height,"captionHeight":caption_height}})
    } }
    pub fn backdrop(&mut self, image: Option<crate::caption_backdrop::Bitmap>) -> Result<bool, String> { unsafe {
        if let Some(image) = &image {
            if !crate::caption_backdrop::enabled() { return Err("Caption wallpaper has not passed native acceptance".into()); }
            if image.frame != self.state.backdrop_frame().0 { return Err("Caption frame changed; compose the current frame".into()); }
        }
        let applied = image.is_some();
        self.state.backdrop.replace(image);
        self.state.update_border_color();
        InvalidateRect(self.state.hwnd, null(), 0);
        for button in self.state.buttons { InvalidateRect(button, null(), 0); }
        UpdateWindow(self.state.hwnd);
        Ok(applied)
    } }
    #[cfg(debug_assertions)]
    pub fn check_wallpaper(&mut self) -> Result<(), String> {
        use base64::{Engine,engine::general_purpose::STANDARD};
        let saved=self.state.backdrop.take(); let dark=self.state.dark.get();
        let palette=self.state.palette.get(); let modal=self.state.modal.get();
        let result=(|| unsafe {
            let frame=self.state.backdrop_frame().0;
            let pixels=[34u8,72,116,255, 34,72,116,255, 102,136,164,255, 102,136,164,255, 166,186,204,255, 166,186,204,255];
            let edges=[[40u8,80,120,255].repeat(1024),[70u8,110,150,255].repeat(1024),[100u8,140,180,255].repeat(1024)].concat();
            let params=serde_json::json!({"surface":{"frame":frame,"width":6,"height":1,"pixels":STANDARD.encode(pixels),"edges":STANDARD.encode(edges)}});
            self.backdrop(crate::caption_backdrop::parse(&params)?)?;
            let original=self.state.colors();
            for dim in [false,true] {
                let values=[original.background,original.track,original.selected,original.text,original.muted,original.accent,original.hover].map(|color|modal_tint(color,dim));
                self.appearance_palette(dark,values,dim);
                let mut client=RECT::default(); GetClientRect(self.state.hwnd,&mut client);
                check_caption_edge_pixels(self.state.hwnd,client)?;
                if IsZoomed(self.state.hwnd)==0 {
                    let inset=insets(self.state.hwnd);
                    let probes=[(inset.left/2,client.bottom/2,0x00785028),(client.right-inset.right/2-1,client.bottom/2,0x00966e46),(client.right/2,client.bottom-inset.bottom/2-1,0x00b48c64)];
                    DwmFlush(); let dc=GetDC(null_mut());
                    let mut failure=None;
                    for (x,y,color) in probes {
                        let mut point=POINT{x,y}; ClientToScreen(self.state.hwnd,&mut point);
                        let actual=GetPixel(dc,point.x,point.y); let expected=modal_tint(color,dim);
                        if actual!=expected { failure=Some(format!("wallpaper perimeter mismatch at {x},{y}: {actual:06x}!={expected:06x}")); }
                    }
                    ReleaseDC(null_mut(),dc);
                    if let Some(error)=failure { return Err(error); }
                    let mut border=0u32;
                    if DwmGetWindowAttribute(self.state.hwnd,DWMWA_BORDER_COLOR as u32,(&mut border as *mut u32).cast(),4)>=0 && border!=0xfffffffe {
                        return Err("wallpaper retained a solid DWM outline".into());
                    }
                }
                let fills=if dark {[0x002d2d48,0x0033335b,0x0039396c]}else{[0x00e8e8fb,0x00d7d7f8,0x00bcbcf1]};
                self.state.check_window_control_pixels(fills.map(|color|modal_tint(color,dim)))?;
                if dim {
                    if self.state.buttons.iter().any(|button| windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled(*button)!=0) {
                        return Err("modal wallpaper left native modes enabled".into());
                    }
                } else { check_native_buttons(self.state.hwnd)?; }
            }
            let mut stale=params.clone(); stale["surface"]["frame"]=serde_json::json!("old-frame");
            if self.backdrop(crate::caption_backdrop::parse(&stale)?).is_ok() || self.backdrop_state()["active"]!=true { return Err("stale frame replaced valid native wallpaper".into()); }
            self.backdrop(None)?;
            if self.backdrop_state()["active"]!=false { return Err("native wallpaper removal failed".into()); }
            let mut border=0u32;
            if DwmGetWindowAttribute(self.state.hwnd,DWMWA_BORDER_COLOR as u32,(&mut border as *mut u32).cast(),4)>=0 && border!=self.state.colors().background {
                return Err("wallpaper removal did not restore native border color".into());
            }
            Ok(())
        })();
        self.state.backdrop.replace(saved); self.apply_appearance(dark,palette,modal);
        result
    }
    #[cfg(debug_assertions)]
    pub fn check_appearance_palette(&mut self) -> Result<(), String> {
        let dark = self.state.dark.get();
        let palette = self.state.palette.get();
        let modal = self.state.modal.get();
        let result = (|| unsafe {
            for (dark, colors, modal, close_fills) in [
                (false, [0x00fbfbfb, 0x00eeeeee, 0x00e7eee7, 0x002e3630, 0x0059645c, 0x005e8067, 0x00eeeeee], false, [0x00e8e8fb, 0x00d7d7f8, 0x00bcbcf1]),
                (true, [0x00090909, 0x00202020, 0x00303030, 0x00f0f0f0, 0x00c0c0c0, 0x00a0a0a0, 0x00202020], false, [0x002d2d48, 0x0033335b, 0x0039396c]),
                (false, [0x009d9f9c, 0x00898b89, 0x00858a85, 0x00202020, 0x00303030, 0x00404040, 0x00898b89], true, [0x008f919a, 0x00868898, 0x00767894]),
            ] {
                self.appearance_palette(dark, colors, modal);
                for (attribute, expected) in [(DWMWA_CAPTION_COLOR, colors[0]), (DWMWA_TEXT_COLOR, colors[3]), (DWMWA_BORDER_COLOR, colors[0])] {
                    // These color attributes are Set-only in the DWM contract.
                    // Assert API acceptance and actual composed pixels below.
                    let hr = DwmSetWindowAttribute(self.state.hwnd, attribute as u32, (&expected as *const u32).cast(), 4);
                    if hr < 0 {
                        return Err(format!("native palette attribute={attribute} hr={hr:#x} expected={expected:#x}"));
                    }
                }
                if self.state.buttons.iter().any(|button| windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled(*button) != i32::from(!modal)) {
                    return Err("native chat modes must follow modal interaction boundary".into());
                }
                let mut client = RECT::default(); GetClientRect(self.state.hwnd, &mut client);
                check_caption_edge_pixels(self.state.hwnd, client)?;
                self.state.check_window_control_pixels(close_fills)?;
            }
            Ok(())
        })();
        self.apply_appearance(dark, palette, modal);
        result
    }
    fn apply_appearance(&mut self, dark: bool, palette: Option<CaptionColors>, modal: bool) {
        if self.state.dark.get() != dark { self.state.backdrop.replace(None); }
        self.state.dark.set(dark);
        self.state.palette.set(palette);
        self.state.modal.set(modal);
        unsafe {
            for button in self.state.buttons { windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(button, (!modal).into()); }
            // Custom pixels reuse Windows-owned caption geometry and command routing.
            let colors = self.state.colors();
            for (attribute, value) in [(DWMWA_CAPTION_COLOR, colors.background), (DWMWA_TEXT_COLOR, colors.text)] {
                DwmSetWindowAttribute(self.state.hwnd, attribute as u32, (&value as *const u32).cast(), 4);
            }
            self.state.update_border_color();
            InvalidateRect(self.state.hwnd, null(), 0); for button in self.state.buttons { InvalidateRect(button, null(), 1); }
        }
    }
}
impl Drop for ChatCaption {
    fn drop(&mut self) {
        unsafe {
            if IsWindow(self.state.hwnd) != 0 {
                RemoveWindowSubclass(self.state.hwnd, Some(caption_proc), SUBCLASS);
                RemovePropW(self.state.hwnd, PROPERTY);
            }
            for button in self.state.buttons { if IsWindow(button) != 0 { RemoveWindowSubclass(button, Some(mode_button_proc), SUBCLASS); DestroyWindow(button); } }
            for font in [&self.state.font, &self.state.selected_font, &self.state.brand_font] {
                if !font.get().is_null() { DeleteObject(font.get()); }
            }
            BufferedPaintUnInit();
            gp::GdiplusShutdown(self.graphics_token);
        }
    }
}
impl State {
    unsafe fn update_border_color(&self) { unsafe {
        // Suppress DWM's solid one-pixel outline only while wallpaper is present.
        // DWMWA_COLOR_NONE does not change the resize frame, shadow or corners.
        let color: u32=if self.backdrop.borrow().is_some() { 0xfffffffe } else { self.colors().background };
        DwmSetWindowAttribute(self.hwnd,DWMWA_BORDER_COLOR as u32,(&color as *const u32).cast(),4);
    } }
    unsafe fn backdrop_frame(&self) -> (String, i32, i32, i32, RECT) { unsafe {
        let mut client = RECT::default(); GetClientRect(self.hwnd, &mut client);
        let inset = insets(self.hwnd);
        let width = client.right-inset.left-inset.right;
        let full_height = client.bottom-inset.top-inset.bottom;
        let caption_height = height(self.hwnd)-inset.top;
        let id = format!("{width}-{full_height}-{caption_height}-{}-{}-{}-{}-{}", GetDpiForWindow(self.hwnd), inset.left, inset.top, inset.right, inset.bottom);
        (id, width, full_height, caption_height, RECT {left:inset.left,top:inset.top,right:client.right-inset.right,bottom:height(self.hwnd)})
    } }
    unsafe fn wallpaper_color(&self, x: i32, y: i32) -> u32 { unsafe {
        let (frame, width, _, caption_height, rect) = self.backdrop_frame();
        self.backdrop.borrow().as_ref().filter(|image|image.frame==frame)
            .map(|image|image.color_at(x-rect.left,y-rect.top,width,caption_height,self.modal.get())).unwrap_or(self.colors().background)
    } }
    unsafe fn paint_backdrop(&self, dc: HDC, offset: POINT) { unsafe {
        let (frame, width, _, caption_height, rect) = self.backdrop_frame();
        let borrow = self.backdrop.borrow();
        let Some(image) = borrow.as_ref().filter(|image|image.frame==frame) else { return; };
        let info = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize:std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth:image.width,biHeight:-image.height,biPlanes:1,biBitCount:32,biCompression:BI_RGB,..Default::default() },..Default::default() };
        let previous=SetStretchBltMode(dc,COLORONCOLOR);
        StretchDIBits(dc,rect.left-offset.x,rect.top-offset.y,width,caption_height,0,0,image.width,image.height,
            image.pixels(self.modal.get()).as_ptr().cast(),&info,DIB_RGB_COLORS,SRCCOPY);
        // Fill the native resize-edge slivers with the nearest wallpaper column.
        // These pixels are outside the WebView, but still visible in the caption.
        let mut client=RECT::default(); GetClientRect(self.hwnd,&mut client);
        for (left,edge_width,source_x) in [(0,rect.left,0),(rect.right,client.right-rect.right,image.width-1)] {
            if edge_width>0 { StretchDIBits(dc,left-offset.x,rect.top-offset.y,edge_width,caption_height,source_x,0,1,image.height,
                image.pixels(self.modal.get()).as_ptr().cast(),&info,DIB_RGB_COLORS,SRCCOPY); }
        }
        SetStretchBltMode(dc,previous);
    } }
    unsafe fn paint_perimeter(&self, dc: HDC) { unsafe {
        let (frame, width, full_height, _, rect)=self.backdrop_frame();
        let borrow=self.backdrop.borrow();
        let Some(image)=borrow.as_ref().filter(|image|image.frame==frame) else { return; };
        let Some((normal,modal))=&image.edges else { return; };
        let pixels=if self.modal.get() { modal } else { normal };
        let mut client=RECT::default(); GetClientRect(self.hwnd,&mut client);
        let inset=insets(self.hwnd);
        // Keep the parent resize-hit area: only its paint changes. The same
        // full-window wallpaper coordinates reach the left/right/bottom edges.
        let previous=SetStretchBltMode(dc,COLORONCOLOR);
        for (left,top,w,h,sw,sh,row) in [
            (0,rect.top,inset.left,full_height,1,1024,0usize),
            (rect.right,rect.top,inset.right,full_height,1,1024,1usize),
            (0,client.bottom-inset.bottom,client.right,inset.bottom,1024,1,2usize),
        ] {
            if w<=0 || h<=0 || width<=0 { continue; }
            let info=BITMAPINFO { bmiHeader:BITMAPINFOHEADER {biSize:std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth:sw,biHeight:-sh,biPlanes:1,biBitCount:32,biCompression:BI_RGB,..Default::default()},..Default::default()};
            StretchDIBits(dc,left,top,w,h,0,0,sw,sh,pixels[row*1024*4..].as_ptr().cast(),&info,DIB_RGB_COLORS,SRCCOPY);
        }
        SetStretchBltMode(dc,previous);
    } }
    #[cfg(debug_assertions)]
    unsafe fn check_window_control_pixels(&self, close_fills: [u32; 3]) -> Result<(), String> { unsafe {
        let mut client = RECT::default(); GetClientRect(self.hwnd, &mut client);
        let inset = insets(self.hwnd);
        let frame = RECT { left: inset.left, top: inset.top, right: client.right-inset.right, bottom: height(self.hwnd) };
        let geometry = client_caption_geometry(self.hwnd, frame);
        let [Some(minimize), Some(maximize), Some(close)] = geometry.controls else { return Err("missing caption visual".into()); };
        let controls = [minimize, maximize, close];
        if controls.iter().any(|rect| (rect.bottom-rect.top)*4 < (rect.right-rect.left)*3) {
            return Err("reference controls must have a rounded-square aspect ratio".into());
        }
        let previous = (self.hot_control.get(), self.pressed_control.get());
        let result = (|| {
            let colors = self.colors();
            for (hot, pressed) in [(0, false), (HTMINBUTTON, false), (HTMAXBUTTON, false), (HTCLOSE, false), (HTCLOSE, true)] {
                self.hot_control.set(hot); self.pressed_control.set(pressed);
                InvalidateRect(self.hwnd, &frame, 0); UpdateWindow(self.hwnd);
                if DwmFlush() < 0 { return Err("control composition did not settle".into()); }
                let points = controls.map(|rect| {
                    let mut point = POINT { x: rect.left+scale(self.hwnd, 3), y: (rect.top+rect.bottom)/2 };
                    ClientToScreen(self.hwnd, &mut point); point
                });
                if points.iter().any(|point| WindowFromPoint(*point) != self.hwnd) { return Err("caption control samples are occluded".into()); }
                let dc = GetDC(null_mut());
                if dc.is_null() { return Err("cannot read composed control pixels".into()); }
                let pixels = points.map(|point| GetPixel(dc, point.x, point.y));
                let mut glyph = POINT { x: (minimize.left+minimize.right)/2, y: (minimize.top+minimize.bottom)/2 };
                ClientToScreen(self.hwnd, &mut glyph);
                let glyph_pixels = [GetPixel(dc, glyph.x, glyph.y-1), GetPixel(dc, glyph.x, glyph.y)];
                ReleaseDC(null_mut(), dc);
                let expected = [if hot==HTMINBUTTON { colors.hover } else { self.wallpaper_color(minimize.left+scale(self.hwnd,3),(minimize.top+minimize.bottom)/2) },
                    if hot==HTMAXBUTTON { colors.hover } else { self.wallpaper_color(maximize.left+scale(self.hwnd,3),(maximize.top+maximize.bottom)/2) },
                    close_fills[if hot==HTCLOSE { if pressed { 2 } else { 1 } } else { 0 }]];
                if pixels != expected { return Err(format!("reference control colors hot={hot} pressed={pressed} actual={pixels:06x?} expected={expected:06x?}")); }
                if glyph_pixels != [colors.muted; 2] { return Err(format!("minimize glyph loses its two visible pixel rows: {glyph_pixels:06x?}")); }
            }
            Ok(())
        })();
        self.hot_control.set(previous.0); self.pressed_control.set(previous.1);
        InvalidateRect(self.hwnd, &frame, 0);
        result
    } }
    unsafe fn extend_frame(&self) { unsafe {
        let margins = MARGINS { cxLeftWidth: 0, cxRightWidth: 0, cyTopHeight: height(self.hwnd), cyBottomHeight: 0 };
        DwmExtendFrameIntoClientArea(self.hwnd, &margins);
    } }
    unsafe fn update_font(&self) { unsafe {
        for (slot, size, weight) in [(&self.font, 14, 400), (&self.selected_font, 14, 600), (&self.brand_font, 17, 600)] {
            let next = CreateFontW(-scale(self.hwnd, size), 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32, CLIP_DEFAULT_PRECIS as u32, CLEARTYPE_QUALITY as u32, DEFAULT_PITCH as u32, w!("Microsoft YaHei UI"));
            if !next.is_null() {
                let old = slot.replace(next);
                if std::ptr::eq(slot, &self.font) { for button in self.buttons { SendMessageW(button, WM_SETFONT, next as usize, 1); } }
                if !old.is_null() { DeleteObject(old); }
            }
        }
    } }
    unsafe fn layout(&self) { unsafe {
        let mut rect = RECT::default(); GetClientRect(self.hwnd, &mut rect);
        let inset = insets(self.hwnd);
        let frame = RECT { left: inset.left, top: inset.top, right: rect.right - inset.right, bottom: height(self.hwnd) };
        let geometry = client_caption_geometry(self.hwnd, frame);
        let compact = frame.right - frame.left < scale(self.hwnd, 1024);
        let width = scale(self.hwnd, if compact { 124 } else { 96 });
        let total = if compact { width } else { width * 3 };
        let button_height = scale(self.hwnd, MODE_HEIGHT);
        let top = geometry.center_y - button_height / 2;
        let left = ((frame.left + frame.right - total) / 2).max(frame.left + scale(self.hwnd, 204))
            .min(self.caption_right() - scale(self.hwnd, 12) - total);
        for (index, button) in self.buttons.iter().enumerate() {
            let show = self.visible.get() && (if compact { index == 3 } else { index < 3 });
            ShowWindow(*button, if show { SW_SHOWNA } else { SW_HIDE });
            if show {
                let x = left + if compact { 0 } else { index as i32 * width };
                SetWindowPos(*button, null_mut(), x, top, width, button_height, SWP_NOZORDER | SWP_NOACTIVATE);
                InvalidateRect(*button, null(), 1);
            }
        }
        SetWindowTextW(self.buttons[3], wide(&format!("{} ▾", LABELS[self.selected.get()])).as_ptr());
        InvalidateRect(self.hwnd, null(), 0);
    } }
    fn colors(&self) -> CaptionColors {
        if let Some(palette) = self.palette.get() { return palette; }
        // COLORREF values for Harbor's backdrop, neutral surfaces and sage selection.
        if self.dark.get() {
            CaptionColors {
                background: 0x0020251d, track: 0x00242a21, selected: 0x00303c2a,
                text: 0x00e9eee9, muted: 0x00bdc8ba, accent: 0x00bfd7b8, hover: 0x00374033,
            }
        } else {
            CaptionColors {
                background: 0x00f1f6f7, track: 0x00ebf2f0, selected: 0x00e7eee7,
                text: 0x0030362e, muted: 0x005c6459, accent: 0x00485d3f, hover: 0x00dde5e1,
            }
        }
    }
    unsafe fn caption_right(&self) -> i32 { unsafe {
        let mut buttons = RECT::default();
        if DwmGetWindowAttribute(self.hwnd, DWMWA_CAPTION_BUTTON_BOUNDS as u32, (&mut buttons as *mut RECT).cast(), std::mem::size_of::<RECT>() as u32) >= 0 && buttons.right > buttons.left {
            buttons.left
        } else {
            let mut client = RECT::default(); GetClientRect(self.hwnd, &mut client);
            client.right - insets(self.hwnd).right - scale(self.hwnd, 144)
        }
    } }
    unsafe fn paint_window_controls(&self, dc: HDC, controls: [Option<RECT>; 3]) { unsafe {
        let colors = self.colors();
        let has_wallpaper = self.backdrop.borrow().as_ref().is_some_and(|image|image.frame==self.backdrop_frame().0);
        let glyph_stroke = 1.4 * GetDpiForWindow(self.hwnd).max(96) as f32 / 96.0;
        for ((index, hit), rect) in SYSTEM_CONTROLS.into_iter().zip(controls) {
            let Some(rect) = rect else { continue; };
            let hot = self.hot_control.get() == hit;
            let fill = if hit == HTCLOSE {
                let states = if self.dark.get() { [0x002d2d48, 0x0033335b, 0x0039396c] } else { [0x00e8e8fb, 0x00d7d7f8, 0x00bcbcf1] };
                Some(modal_tint(states[if hot { if self.pressed_control.get() { 2 } else { 1 } } else { 0 }], self.modal.get()))
            } else if hot { Some(colors.hover) } else if has_wallpaper { None } else { Some(colors.background) };
            rounded(dc, rect, scale(self.hwnd, 8), fill, None);
            // Opaque buffered pixels cover the glyph; center it in the painted shape.
            let x = (rect.left + rect.right) / 2; let y = (rect.top + rect.bottom) / 2;
            let r = scale(self.hwnd, 5);
            let color = if hit == HTCLOSE { modal_tint(if self.dark.get() { 0x00a3a3f2 } else { 0x003e3ec4 }, self.modal.get()) } else { colors.muted };
            if index == 2 {
                // A pixel-aligned bar stays visible when a fractional-DPI hairline fades.
                let thickness = scale(self.hwnd, 2);
                let top = y - thickness / 2;
                let glyph = RECT { left: x-r, top, right: x+r+1, bottom: top + thickness };
                let brush = CreateSolidBrush(color);
                FillRect(dc, &glyph, brush);
                DeleteObject(brush);
            } else if index == 3 {
                let mut glyph = RECT { left: x-r, top: y-r, right: x+r, bottom: y+r };
                if IsZoomed(self.hwnd) != 0 {
                    OffsetRect(&mut glyph, scale(self.hwnd, 2), -scale(self.hwnd, 2));
                    rounded(dc, glyph, scale(self.hwnd, 2), None, Some((color, glyph_stroke)));
                    OffsetRect(&mut glyph, -scale(self.hwnd, 2), scale(self.hwnd, 2));
                }
                rounded(dc, glyph, scale(self.hwnd, 2), Some(fill.unwrap_or_else(||self.wallpaper_color(x,y))), Some((color, glyph_stroke)));
            } else {
                let mut graphics = null_mut(); let mut pen = null_mut();
                let argb = 0xff000000 | ((color & 255) << 16) | (color & 0xff00) | ((color >> 16) & 255);
                if gp::GdipCreateFromHDC(dc, &mut graphics) == gp::Ok {
                    gp::GdipSetSmoothingMode(graphics, gp::SmoothingModeAntiAlias);
                    if gp::GdipCreatePen1(argb, glyph_stroke, gp::UnitPixel, &mut pen) == gp::Ok {
                        gp::GdipDrawLine(graphics, pen, (x-r) as f32, (y-r) as f32, (x+r) as f32, (y+r) as f32);
                        gp::GdipDrawLine(graphics, pen, (x+r) as f32, (y-r) as f32, (x-r) as f32, (y+r) as f32);
                        gp::GdipDeletePen(pen);
                    }
                    gp::GdipDeleteGraphics(graphics);
                }
            }
        }
    } }
    unsafe fn paint_button(&self, draw: &DRAWITEMSTRUCT) { unsafe {
        let mut buffered_dc = null_mut();
        let buffer = BeginBufferedPaint(draw.hDC, &draw.rcItem, BPBF_TOPDOWNDIB, null(), &mut buffered_dc);
        let dc = if buffer != 0 { buffered_dc } else { draw.hDC };
        let colors = self.colors();
        let selected = draw.CtlID as usize == FIRST_ID + self.selected.get() || draw.CtlID as usize == FIRST_ID + 3;
        let brush = CreateSolidBrush(colors.background);
        FillRect(dc, &draw.rcItem, brush); DeleteObject(brush);
        let mut origin=POINT::default(); MapWindowPoints(draw.hwndItem,self.hwnd,&mut origin,1);
        self.paint_backdrop(dc,origin);
        let index = draw.CtlID as usize - FIRST_ID;
        let width = draw.rcItem.right - draw.rcItem.left;
        let mut track_rect = draw.rcItem;
        if index < 3 { track_rect.left -= index as i32 * width; track_rect.right += (2-index) as i32 * width; }
        rounded(dc, track_rect, scale(self.hwnd, 12), Some(colors.track), None);
        if selected {
            let mut active = draw.rcItem; InflateRect(&mut active, -scale(self.hwnd, 2), -scale(self.hwnd, 2));
            rounded(dc, active, scale(self.hwnd, 10), Some(colors.selected), None);
        }
        let old_font = SelectObject(dc, if selected { self.selected_font.get() } else { self.font.get() });
        SetBkMode(dc, TRANSPARENT as i32); SetTextColor(dc, if selected { colors.accent } else { colors.muted });
        let label = if index == 3 { format!("{} ▾", LABELS[self.selected.get()]) } else { LABELS[index.min(2)].to_owned() };
        let mut rect = draw.rcItem;
        DrawTextW(dc, wide(&label).as_ptr(), -1, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        if draw.itemState & ODS_FOCUS != 0 && SendMessageW(draw.hwndItem, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS as isize == 0 {
            // Continuous rounded keyboard indicator; mouse selection does not add a focus ring.
            InflateRect(&mut rect, -scale(self.hwnd, 2), -scale(self.hwnd, 2));
            rounded(dc, rect, scale(self.hwnd, 10), None, Some((colors.accent, 1.0)));
        }
        SelectObject(dc, old_font);
        if buffer != 0 { BufferedPaintSetAlpha(buffer, null(), 255); EndBufferedPaint(buffer, 1); }
    } }
}

unsafe extern "system" fn mode_button_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM, _: usize, data: usize) -> LRESULT { unsafe {
    let state = &*(data as *const State);
    if message == WM_LBUTTONDOWN { SendMessageW(hwnd, WM_CHANGEUISTATE, (UIS_SET | (UISF_HIDEFOCUS << 16)) as usize, 0); }
    if message == WM_KEYDOWN {
        SendMessageW(hwnd, WM_CHANGEUISTATE, (UIS_CLEAR | (UISF_HIDEFOCUS << 16)) as usize, 0);
        let visible: Vec<HWND> = state.buttons.iter().copied().filter(|button| IsWindowVisible(*button) != 0).collect();
        if let Some(index) = visible.iter().position(|button| *button == hwnd) {
            let last = visible.len() - 1;
            let target = match wp as u16 {
                VK_LEFT => Some(visible[if index == 0 { last } else { index - 1 }]),
                VK_RIGHT => Some(visible[(index + 1) % visible.len()]),
                VK_HOME => Some(visible[0]), VK_END => Some(visible[last]),
                VK_TAB => Some(if GetKeyState(VK_SHIFT as i32) < 0 {
                    if index == 0 { state.hwnd } else { visible[index - 1] }
                } else if index == last { state.hwnd } else { visible[index + 1] }),
                VK_RETURN => { SendMessageW(hwnd, BM_CLICK, 0, 0); return 0; }
                _ => None,
            };
            if let Some(target) = target { SetFocus(target); return 0; }
        }
    }
    if message == WM_NCDESTROY { RemoveWindowSubclass(hwnd, Some(mode_button_proc), SUBCLASS); }
    DefSubclassProc(hwnd, message, wp, lp)
} }

unsafe extern "system" fn caption_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM, _: usize, data: usize) -> LRESULT { unsafe {
    let state = &*(data as *const State);
    // Observe native interaction without replacing its dispatch (including Snap).
    if message == WM_NCMOUSEMOVE || message == WM_NCLBUTTONDOWN {
        let hot = if [HTMINBUTTON, HTMAXBUTTON, HTCLOSE].contains(&(wp as u32)) { wp as u32 } else { 0 };
        if state.hot_control.replace(hot) != hot || message == WM_NCLBUTTONDOWN {
            state.pressed_control.set(message == WM_NCLBUTTONDOWN);
            let mut rect = RECT::default(); GetClientRect(hwnd, &mut rect); rect.bottom = height(hwnd);
            InvalidateRect(hwnd, &rect, 0);
            if message == WM_NCLBUTTONDOWN { UpdateWindow(hwnd); }
        }
        let mut tracking = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
        TrackMouseEvent(&mut tracking);
    }
    if message == WM_NCMOUSELEAVE || message == WM_CANCELMODE || (message == WM_ACTIVATE && wp & 0xffff == WA_INACTIVE as usize) {
        state.hot_control.set(0); state.pressed_control.set(false);
        let mut rect = RECT::default(); GetClientRect(hwnd, &mut rect); rect.bottom = height(hwnd); InvalidateRect(hwnd, &rect, 0);
    }
    if message == WM_NCCALCSIZE && wp != 0 {
        // DWM custom-frame contract: do not first apply a standard caption inset.
        // Keep the full rectangle even maximized; an inset disables DWM's caption
        // layout. Our content bounds separately exclude the off-screen resize frame.
        return 0;
    }
    let mut dwm_result = 0;
    let dwm_handled = DwmDefWindowProc(hwnd, message, wp, lp, &mut dwm_result) != 0;
    if message == WM_NCHITTEST {
        if dwm_handled { return dwm_result; }
        let mut point = POINT { x: lp as i16 as i32, y: (lp >> 16) as i16 as i32 };
        ScreenToClient(hwnd, &mut point);
        let mut rect = RECT::default(); GetClientRect(hwnd, &mut rect);
        if IsZoomed(hwnd) == 0 {
            let edge = resize_edge(hwnd);
            let left = point.x < edge; let right = point.x >= rect.right - edge;
            let top = point.y < edge; let bottom = point.y >= rect.bottom - edge;
            let hit = match (left, right, top, bottom) {
                (true, _, true, _) => HTTOPLEFT, (_, true, true, _) => HTTOPRIGHT,
                (true, _, _, true) => HTBOTTOMLEFT, (_, true, _, true) => HTBOTTOMRIGHT,
                (true, _, _, _) => HTLEFT, (_, true, _, _) => HTRIGHT,
                (_, _, true, _) => HTTOP, (_, _, _, true) => HTBOTTOM, _ => HTCLIENT,
            };
            if hit != HTCLIENT { return hit as isize; }
        }
        if point.y < height(hwnd) {
            let inset = insets(hwnd);
            let frame = RECT { left: inset.left, top: inset.top, right: rect.right-inset.right, bottom: height(hwnd) };
            let geometry = client_caption_geometry(hwnd, frame);
            for ((_, hit), visual) in SYSTEM_CONTROLS.into_iter().zip(geometry.controls) {
                if visual.is_some_and(|visual| point.x>=visual.left && point.x<visual.right && point.y>=visual.top && point.y<visual.bottom) {
                    return hit as isize;
                }
            }
            return HTCAPTION as isize;
        }
        return HTCLIENT as isize;
    }
    match message {
        WM_COMMAND if (FIRST_ID..FIRST_ID + 4).contains(&(wp & 0xffff)) && (wp >> 16) == BN_CLICKED as usize => {
            let index = (wp & 0xffff) - FIRST_ID;
            if state.modal.get() || !state.visible.get() || lp as HWND != state.buttons[index] { return 0; }
            if index < 3 { (state.select)(index); }
            else {
                let menu = CreatePopupMenu();
                if !menu.is_null() {
                    for (i, label) in LABELS.iter().enumerate() { AppendMenuW(menu, MF_STRING | if i == state.selected.get() { MF_CHECKED } else { 0 }, i + 1, wide(label).as_ptr()); }
                    let mut rect = RECT::default(); GetWindowRect(state.buttons[3], &mut rect);
                    let selected = TrackPopupMenu(menu, TPM_RETURNCMD, rect.left, rect.bottom, 0, hwnd, null());
                    DestroyMenu(menu); if (1..=3).contains(&selected) { (state.select)(selected as usize - 1); }
                }
            }
            return 0;
        }
        WM_DRAWITEM if (FIRST_ID..FIRST_ID + 4).contains(&wp) => { state.paint_button(&*(lp as *const DRAWITEMSTRUCT)); return 1; }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default(); let dc = BeginPaint(hwnd, &mut ps);
            let mut client = RECT::default(); GetClientRect(hwnd, &mut client);
            let mut band = RECT { bottom: height(hwnd), ..client };
            FillRect(dc, &band, GetStockObject(BLACK_BRUSH));
            let inset = insets(hwnd);
            band.top = inset.top;
            let mut rect = RECT { left: inset.left, right: client.right - inset.right, ..band };
            let colors = state.colors();
            let brush = CreateSolidBrush(colors.background);
            if IsZoomed(hwnd) == 0 {
                for edge in [
                    RECT { left: 0, top: band.bottom, right: inset.left, bottom: client.bottom },
                    RECT { left: client.right - inset.right, top: band.bottom, right: client.right, bottom: client.bottom },
                    RECT { left: 0, top: client.bottom - inset.bottom, right: client.right, bottom: client.bottom },
                ] { FillRect(dc, &edge, brush); }
                state.paint_perimeter(dc);
            }
            let geometry = client_caption_geometry(hwnd, rect);
            let mut buffered_dc = null_mut();
            // The extended DWM frame includes both resize edges. Paint the whole band with opaque alpha.
            let buffer = BeginBufferedPaint(dc, &band, BPBF_TOPDOWNDIB, null(), &mut buffered_dc);
            let target = dc; let dc = if buffer != 0 { buffered_dc } else { target };
            FillRect(dc, &band, brush); DeleteObject(brush);
            state.paint_backdrop(dc,POINT::default());
            state.paint_window_controls(dc, geometry.controls);
            let font = SelectObject(dc, state.brand_font.get()); SetBkMode(dc, TRANSPARENT as i32); SetTextColor(dc, colors.text);
            rect.bottom = 2 * geometry.center_y - rect.top;
            rect.left += geometry.gutter; DrawTextW(dc, w!("CetaMesh"), -1, &mut rect, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
            SelectObject(dc, font);
            if buffer != 0 { BufferedPaintSetAlpha(buffer, null(), 255); EndBufferedPaint(buffer, 1); }
            EndPaint(hwnd, &ps); return 0;
        }
        WM_SIZE => { state.layout(); }
        WM_ACTIVATE => { state.extend_frame(); }
        WM_DPICHANGED => { let result = DefSubclassProc(hwnd, message, wp, lp); state.update_font(); state.extend_frame(); state.layout(); return result; }
        WM_NCDESTROY => { RemovePropW(hwnd, PROPERTY); RemoveWindowSubclass(hwnd, Some(caption_proc), SUBCLASS); }
        _ => {}
    }
    let result = if dwm_handled { dwm_result } else { DefSubclassProc(hwnd, message, wp, lp) };
    if message == WM_NCLBUTTONDOWN && IsWindow(hwnd) != 0 && GetPropW(hwnd, PROPERTY) == data as *mut std::ffi::c_void {
        // Native tracking may run a nested loop; only reborrow our still-attached state.
        let state = &*(data as *const State);
        state.pressed_control.set(false);
        let mut rect = RECT::default(); GetClientRect(hwnd, &mut rect); rect.bottom = height(hwnd); InvalidateRect(hwnd, &rect, 0);
    }
    result
} }
