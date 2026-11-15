//! Main presentation surface shared by the product host and native resize regression.
use tao::{dpi::{PhysicalPosition, PhysicalSize}, window::Window};
use wry::{Rect, WebView, WebViewBuilder, WebViewExtWindows};

fn bounds(window: &Window) -> Rect {
    use tao::platform::windows::WindowExtWindows;
    let top = crate::chat_caption::height(window.hwnd() as _) as u32;
    let inset = crate::chat_caption::insets(window.hwnd() as _);
    let size = window.inner_size();
    Rect { position: PhysicalPosition::new(inset.left, top as i32).into(), size: PhysicalSize::new(size.width.saturating_sub((inset.left + inset.right) as u32), size.height.saturating_sub(top + inset.bottom as u32)).into() }
}

pub fn build(builder: WebViewBuilder<'_>, window: &Window) -> wry::Result<WebView> {
    // Wry 0.55.1 removes its shared parent resize subclass when ANY child view
    // is dropped. Own the main surface geometry explicitly so closing a preview
    // cannot disable resizing of the application's presentation surface.
    builder.with_bounds(bounds(window)).build_as_child(window)
}

pub fn resized(view: &WebView, window: &Window) -> wry::Result<()> {
    let size: PhysicalSize<u32> = window.inner_size();
    // A minimized client can be zero-sized; retain its last usable bounds.
    if size.width == 0 || size.height == 0 { return Ok(()); }
    view.set_bounds(bounds(window))?;
    unsafe { view.controller().NotifyParentWindowPositionChanged()?; }
    view.evaluate_script("window.dispatchEvent(new Event('resize'))")
}

#[cfg(debug_assertions)]
pub fn smoke(report: &std::path::Path, caption_test: bool) -> Result<(), String> {
    smoke_inner(report,caption_test,false)
}

#[cfg(debug_assertions)]
pub fn wallpaper_smoke(report: &std::path::Path) -> Result<(), String> {
    smoke_inner(report,true,true)
}

#[cfg(debug_assertions)]
fn smoke_inner(report: &std::path::Path, caption_test: bool, wallpaper_test: bool) -> Result<(), String> {
    use std::time::{Duration, Instant};
    use tao::{dpi::LogicalSize, event::{Event, WindowEvent}, event_loop::{ControlFlow, EventLoopBuilder}, window::WindowBuilder};
    use windows_sys::Win32::{Foundation::RECT, UI::WindowsAndMessaging::GetClientRect};
    use wry::{WebContext, WebViewExtWindows};
    let event_loop = EventLoopBuilder::<()>::with_user_event().build();
    // Pixel checks must observe this owned test window, not a foreground user app.
    // The temporary topmost flag ends with the smoke process; product behavior is unchanged.
    let window = WindowBuilder::new().with_title("CetaMesh resize regression").with_always_on_top(caption_test)
        .with_inner_size(LogicalSize::new(960.0, 640.0)).build(&event_loop).map_err(|e| e.to_string())?;
    use tao::platform::windows::WindowExtWindows;
    let mut caption = if caption_test { Some(crate::chat_caption::ChatCaption::install(window.hwnd() as _, |_| {})?) } else { None };
    if let Some(caption) = &mut caption { caption.show_mode(Some(1)); }
    let directory = report.parent().ok_or("Missing report directory")?;
    let mut context = WebContext::new(Some(directory.join("main-profile")));
    let view = build(WebViewBuilder::new_with_web_context(&mut context)
        .with_html("<body style='margin:0;background:#e6eee7'><h1>CetaMesh resize regression</h1><p>Native main view must fill this window after preview close, resize, maximize and restore.</p></body>"), &window).map_err(|e| e.to_string())?;
    let mut preview_context = WebContext::new(Some(directory.join("preview-profile")));
    let preview = WebViewBuilder::new_with_web_context(&mut preview_context)
        .with_html("<body>Preview</body>").with_visible(false)
        .build_as_child(&window).map_err(|e| e.to_string())?;
    // Closing a preview used to remove Wry's parent auto-resize subclass, even for a child.
    drop(preview);
    crate::chat_caption::set_client_size(&window, LogicalSize::new(1100.0, 720.0).to_physical(window.scale_factor()));
    let mut deadline = Instant::now() + Duration::from_millis(800);
    let mut phase = 0;
    let output = report.to_owned();
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::WaitUntil(deadline);
        if let Event::WindowEvent { event: WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }, .. } = event {
            if let Err(error) = resized(&view, &window) {
                let _ = std::fs::write(&output, format!("FAIL native resize: {error}"));
                *flow = ControlFlow::Exit;
                return;
            }
        }
        if !matches!(event, Event::MainEventsCleared) || Instant::now() < deadline { return; }
        let _retain_caption = &caption;
        let size = window.inner_size();
        if caption_test {
            if wallpaper_test {
                if let Some(caption)=&mut caption {
                    if let Err(error)=caption.check_wallpaper() {
                        let _=std::fs::write(&output,format!("FAIL native wallpaper phase={phase}: {error}")); *flow=ControlFlow::Exit; return;
                    }
                }
            }
            if phase == 0 {
                if let Some(caption) = &mut caption {
                    if let Err(error) = caption.check_appearance_palette() {
                        let _ = std::fs::write(&output, format!("FAIL native appearance {error}")); *flow = ControlFlow::Exit; return;
                    }
                }
            }
            if let Err(error) = crate::chat_caption::check_native_buttons(window.hwnd() as _) {
                let _ = std::fs::write(&output, format!("FAIL phase={phase} {error}")); *flow = ControlFlow::Exit; return;
            }
            let visible = unsafe { (0..4).filter(|index| {
                windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(
                    windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(window.hwnd() as _, 0x7010 + index)) != 0
            }).count() };
            let expected = if phase == 4 { 0 } else if phase == 3 { 1 } else { 3 };
            if visible != expected {
                let _ = std::fs::write(&output, format!("FAIL phase={phase} mode visibility {visible} expected {expected}")); *flow = ControlFlow::Exit; return;
            }
        }
        let normal_size = match phase { 0 | 2 => Some((1100.0, 720.0)), 3 => Some((980.0, 660.0)), _ => None };
        if let Some((width, height)) = normal_size {
            let expected = LogicalSize::new(width, height).to_physical::<u32>(window.scale_factor());
            if window.is_maximized() || size.width.abs_diff(expected.width) > 1 || size.height.abs_diff(expected.height) > 1 {
                let _ = std::fs::write(&output, format!("FAIL phase={phase} requested normal size={}x{} actual={}x{} maximized={}", expected.width, expected.height, size.width, size.height, window.is_maximized()));
                *flow = ControlFlow::Exit;
                return;
            }
        }
        let controller = view.controller();
        let mut bounds = windows::Win32::Foundation::RECT::default();
        let mut container = windows::Win32::Foundation::HWND::default();
        let mut client = RECT::default();
        let observed = unsafe {
            controller.Bounds(&mut bounds).and_then(|()| controller.ParentWindow(&mut container))
                .map_err(|e| e.to_string()).and_then(|()| {
                    if GetClientRect(container.0, &mut client) == 0 { Err("GetClientRect failed".to_owned()) } else { Ok(()) }
                })
        };
        let caption_height = crate::chat_caption::height(window.hwnd() as _);
        let inset = crate::chat_caption::insets(window.hwnd() as _);
        let expected_width = size.width as i32 - inset.left - inset.right;
        let expected_height = size.height as i32 - caption_height - inset.bottom;
        let matches = bounds.left == 0 && bounds.top == 0 && bounds.right == expected_width && bounds.bottom == expected_height
            && client.right == expected_width && client.bottom == expected_height;
        if observed.is_err() || !matches {
            let _ = std::fs::write(&output, format!("FAIL phase={phase} window={}x{} controller={}x{} container={}x{} error={observed:?}", size.width, size.height, bounds.right, bounds.bottom, client.right, client.bottom));
            *flow = ControlFlow::Exit;
            return;
        }
        match phase {
            0 => window.set_maximized(true),
            1 if !window.is_maximized() => {
                let _ = std::fs::write(&output, "FAIL maximize did not take effect"); *flow = ControlFlow::Exit; return;
            }
            1 => window.set_maximized(false),
            2 => {
                if let Some(caption) = &mut caption { caption.appearance(true); }
                crate::chat_caption::set_client_size(&window, LogicalSize::new(980.0, 660.0).to_physical(window.scale_factor()));
            }
            3 if caption_test => { if let Some(caption) = &mut caption { caption.show_mode(None); } }
            _ => { let dpi=unsafe {windows_sys::Win32::UI::HiDpi::GetDpiForWindow(window.hwnd() as _)};
                let _ = std::fs::write(&output, format!("PASS real WebView2 main controller and child HWND fill physical client bounds after preview destruction, resize, maximize, restore and resize again; dpi={dpi}; wallpaper={wallpaper_test}")); *flow = ControlFlow::Exit; return; }
        }
        phase += 1;
        deadline = Instant::now() + Duration::from_millis(500);
    });
}
