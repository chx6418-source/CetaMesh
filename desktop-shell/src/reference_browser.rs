//! One unprivileged child WebView. No application protocol, host objects or IPC.
use std::{cell::{Cell, RefCell}, path::Path, rc::Rc};
use serde_json::{Value, json};
use tao::{dpi::{PhysicalPosition, PhysicalSize}, window::Window};
use windows::core::{BOOL, HSTRING, Interface, PWSTR, w};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR, DocumentTitleChangedEventHandler, HistoryChangedEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler, PermissionRequestedEventHandler, SourceChangedEventHandler, WebResourceRequestedEventHandler};
use wry::{NewWindowResponse, Rect, WebContext, WebView, WebViewBuilder, WebViewExtWindows};
use crate::reference_browser_policy::allowed_url;

type Notify = Rc<dyn Fn(Value)>;
pub struct ReferenceBrowser {
    pub id: String,
    view: WebView,
    _context: WebContext,
    ready: Rc<Cell<bool>>,
    visible: Rc<Cell<bool>>,
    alive: Rc<Cell<bool>>,
    temporarily_hidden: Cell<bool>,
}
impl Drop for ReferenceBrowser {
    fn drop(&mut self) { self.alive.set(false); let _ = self.view.set_visible(false); }
}
fn event(notify: &Notify, id: &str, revision: u64, url: &str, loading: bool, error: &str, view: Option<&ICoreWebView2>) {
    let mut title = PWSTR::null();
    if let Some(view) = view { unsafe { let _ = view.DocumentTitle(&mut title); } }
    let title = CoTaskMemPWSTR::from(title).to_string();
    notify(json!({"targetId":id,"revision":revision,"url":url,"title":title,"loading":loading,"error":error}));
    if let Some(view) = view {
        let notify = notify.clone(); let id = id.to_owned();
        unsafe { let _ = view.CallDevToolsProtocolMethod(w!("Page.getNavigationHistory"), w!("{}"), &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, value| {
            if result.is_err() { return Ok(()); }
            let Ok(history) = serde_json::from_str::<Value>(&value) else { return Ok(()); };
            let Some(entries) = history["entries"].as_array() else { return Ok(()); };
            let current = history["currentIndex"].as_u64().unwrap_or(0) as usize;
            let mut urls = Vec::new(); let mut index = None;
            for (i, entry) in entries.iter().enumerate() {
                if let Some(url) = entry["url"].as_str().filter(|url| allowed_url(url)) {
                    if i == current { index = Some(urls.len()); }
                    urls.push(url.to_owned());
                }
            }
            if let Some(index) = index { let start = index.saturating_sub(49); let urls: Vec<_> = urls.into_iter().skip(start).take(50).collect(); notify(json!({"targetId":id,"revision":revision,"historyUrls":urls,"historyIndex":index-start,"canBack":index>start,"canForward":index-start+1<urls.len()})); }
            Ok(())
        }))); }
    }
}
fn source(view: &ICoreWebView2) -> String {
    let mut value = PWSTR::null(); unsafe { let _ = view.Source(&mut value); }
    CoTaskMemPWSTR::from(value).to_string()
}
fn clipped(window: &Window, params: &Value) -> Rect {
    let size = window.inner_size();
    let scale = params["scale"].as_f64().unwrap_or(1.0);
    let x = (params["x"].as_f64().unwrap_or(0.0) * scale).round().clamp(56.0 * window.scale_factor(), f64::from(size.width).max(56.0 * window.scale_factor()));
    let y = (params["y"].as_f64().unwrap_or(0.0) * scale).round().clamp(40.0 * window.scale_factor(), f64::from(size.height).max(40.0 * window.scale_factor()));
    let width = (params["width"].as_f64().unwrap_or(0.0) * scale).round().clamp(0.0, (f64::from(size.width) - x).max(0.0));
    let height = (params["height"].as_f64().unwrap_or(0.0) * scale).round().clamp(0.0, (f64::from(size.height) - y).max(0.0));
    Rect { position: PhysicalPosition::new(x as i32, y as i32).into(), size: PhysicalSize::new(width as u32, height as u32).into() }
}

impl ReferenceBrowser {
    pub fn new(window: &Window, profile: &Path, id: String, url: String, bounds: &Value, notify: Notify) -> Result<Self, String> {
        if !allowed_url(&url) { return Err("不允许在应用内打开此地址。".into()); }
        let mut context = WebContext::new(Some(profile.to_path_buf()));
        let ready = Rc::new(Cell::new(false));
        let visible = Rc::new(Cell::new(false));
        let alive = Rc::new(Cell::new(true));
        let alive_nav = alive.clone();
        let view = WebViewBuilder::new_with_web_context(&mut context)
            .with_url("about:blank").with_incognito(true).with_visible(false).with_devtools(false).with_clipboard(false)
            .with_bounds(clipped(window, bounds))
            .with_navigation_handler(move |target| alive_nav.get() && (target == "about:blank" || allowed_url(&target)))
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_download_started_handler(|_, _| false)
            .with_initialization_script("addEventListener('dragover',e=>{e.preventDefault();e.stopImmediatePropagation()},true);addEventListener('drop',e=>{e.preventDefault();e.stopImmediatePropagation()},true);")
            .build_as_child(window).map_err(|_| "无法创建独立网页查看区域。".to_owned())?;
        let core = view.webview();
        let revision = Rc::new(Cell::new(0u64));
        let navigation = Rc::new(Cell::new(0u64));
        let loading = Rc::new(Cell::new(true));
        let failure = Rc::new(RefCell::new(String::new()));
        let mut token = 0;
        // Install all guards while the view is hidden and has not loaded external content.
        unsafe {
            let settings = core.Settings().map_err(|_| "无法设置网页权限。")?;
            settings.SetIsWebMessageEnabled(false).map_err(|_| "无法禁用网页消息。")?;
            settings.SetAreHostObjectsAllowed(false).map_err(|_| "无法禁用网页主机对象。")?;
            settings.SetAreDefaultScriptDialogsEnabled(false).map_err(|_| "无法禁用网页对话框。")?;
            settings.SetAreDevToolsEnabled(false).map_err(|_| "无法禁用网页调试。")?;
            settings.SetAreDefaultContextMenusEnabled(false).map_err(|_| "无法禁用网页菜单。")?;
            let focus_notify = notify.clone(); let focus_id = id.clone();
            view.controller().add_AcceleratorKeyPressed(&AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args { let mut key = 0; args.VirtualKey(&mut key)?; if key == 27 { args.SetHandled(true)?; focus_notify(json!({"targetId":focus_id,"focusRequested":true})); } } Ok(())
            })), &mut token).map_err(|_| "无法设置网页返回焦点操作。")?;
            core.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(|_, args| { if let Some(args) = args { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?; } Ok(()) })), &mut token).map_err(|_| "无法设置网页权限拦截。")?;
            let notify_start = notify.clone(); let id_start = id.clone(); let rev_start = revision.clone(); let nav_start = navigation.clone(); let alive_start = alive.clone(); let ready_start = ready.clone(); let loading_start = loading.clone(); let failure_start = failure.clone();
            core.add_NavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut uri = PWSTR::null(); args.Uri(&mut uri)?; let target = CoTaskMemPWSTR::from(uri).to_string();
                    if !alive_start.get() { args.SetCancel(true)?; return Ok(()); }
                    if target == "about:blank" { if ready_start.get() { args.SetCancel(true)?; } return Ok(()); }
                    if !allowed_url(&target) { args.SetCancel(true)?; event(&notify_start, &id_start, rev_start.get(), "", false, "已阻止不允许的网页跳转。", None); return Ok(()); }
                    let mut nav_id = 0; args.NavigationId(&mut nav_id)?; nav_start.set(nav_id);
                    failure_start.borrow_mut().clear(); loading_start.set(true); rev_start.set(rev_start.get() + 1); event(&notify_start, &id_start, rev_start.get(), &target, true, "", None);
                } Ok(())
            })), &mut token).map_err(|_| "无法设置网页导航拦截。")?;
            core.add_FrameNavigationStarting(&NavigationStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args { let mut uri = PWSTR::null(); args.Uri(&mut uri)?; let target = CoTaskMemPWSTR::from(uri).to_string(); if target != "about:blank" && !allowed_url(&target) { args.SetCancel(true)?; } } Ok(())
            })), &mut token).map_err(|_| "无法设置网页框架拦截。")?;
            let notify_done = notify.clone(); let id_done = id.clone(); let rev_done = revision.clone(); let nav_done = navigation.clone(); let alive_done = alive.clone(); let loading_done = loading.clone(); let failure_done = failure.clone();
            core.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                if !alive_done.get() { return Ok(()); }
                if let (Some(sender), Some(args)) = (sender, args) {
                    let mut nav_id = 0; args.NavigationId(&mut nav_id)?;
                    if nav_id != nav_done.get() { return Ok(()); }
                    let current = source(&sender); if current == "about:blank" { return Ok(()); }
                    let mut success = BOOL::default(); args.IsSuccess(&mut success)?;
                    loading_done.set(false); rev_done.set(rev_done.get() + 1);
                    *failure_done.borrow_mut() = if success.as_bool() { "" } else { "网页未能加载，请重试或在浏览器中打开。" }.to_owned();
                    event(&notify_done, &id_done, rev_done.get(), &current, false, &failure_done.borrow(), Some(&sender));
                } Ok(())
            })), &mut token).map_err(|_| "无法监听网页加载结果。")?;
            let state_notify = notify.clone(); let state_id = id.clone(); let state_rev = revision.clone(); let state_loading = loading.clone(); let state_alive = alive.clone(); let state_failure = failure.clone();
            let publish = Rc::new(move |sender: Option<ICoreWebView2>| {
                if !state_alive.get() { return; }
                if let Some(sender) = sender { let url = source(&sender); if allowed_url(&url) { state_rev.set(state_rev.get() + 1); event(&state_notify, &state_id, state_rev.get(), &url, state_loading.get(), &state_failure.borrow(), Some(&sender)); } }
            });
            let changed = publish.clone();
            core.add_SourceChanged(&SourceChangedEventHandler::create(Box::new(move |sender, _| { changed(sender); Ok(()) })), &mut token).map_err(|_| "无法监听网页地址变化。")?;
            let changed = publish.clone();
            core.add_HistoryChanged(&HistoryChangedEventHandler::create(Box::new(move |sender, _| { changed(sender); Ok(()) })), &mut token).map_err(|_| "无法监听页面历史变化。")?;
            core.add_DocumentTitleChanged(&DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| { publish(sender); Ok(()) })), &mut token).map_err(|_| "无法监听网页标题变化。")?;
            let environment = view.environment();
            core.cast::<ICoreWebView2_22>().map_err(|_| "当前 WebView2 不支持完整网页资源隔离，请升级运行时。")?
                .AddWebResourceRequestedFilterWithRequestSourceKinds(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL).map_err(|_| "无法设置网页资源过滤。")?;
            core.add_WebResourceRequested(&WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let request = args.Request()?; let mut uri = PWSTR::null(); request.Uri(&mut uri)?; let target = CoTaskMemPWSTR::from(uri).to_string();
                    if !allowed_url(&target) && !target.starts_with("data:") && target != "about:blank" {
                        let response = environment.CreateWebResourceResponse(None, 403, w!("Blocked"), w!("Content-Type: text/plain"))?;
                        args.SetResponse(&response)?;
                    }
                } Ok(())
            })), &mut token).map_err(|_| "无法安装网页资源过滤。")?;
            let ready_done = ready.clone(); let alive_cdp = alive.clone(); let core_ready = core.clone(); let id_ready = id.clone(); let notify_ready = notify.clone();
            core.CallDevToolsProtocolMethod(w!("Page.setInterceptFileChooserDialog"), w!("{\"enabled\":true}"), &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
                if !alive_cdp.get() { return Ok(()); }
                if result.is_err() { event(&notify_ready, &id_ready, 0, &url, false, "当前 WebView2 无法禁用文件选择，请使用系统浏览器。", None); return Ok(()); }
                ready_done.set(true);
                notify_ready(json!({"targetId":id_ready,"initialized":true}));
                core_ready.Navigate(&HSTRING::from(url.as_str()))?;
                Ok(())
            }))).map_err(|_| "无法安全初始化网页查看。")?;
        }
        Ok(Self { id, view, _context: context, ready, visible, alive, temporarily_hidden: Cell::new(false) })
    }
    pub fn layout(&self, window: &Window, bounds: &Value, visible: bool) -> Result<(), String> {
        self.view.set_bounds(clipped(window, bounds)).map_err(|_| "无法调整网页区域。")?;
        self.visible.set(visible);
        self.view.set_visible(visible && self.ready.get() && !self.temporarily_hidden.get()).map_err(|_| "无法切换网页显示。".into())
    }
    pub fn hide(&self) { self.temporarily_hidden.set(true); let _ = self.view.set_visible(false); }
    pub fn resume(&self) { if self.temporarily_hidden.replace(false) { let _ = self.view.set_visible(self.visible.get() && self.ready.get()); } }
    pub fn reapply_visibility(&self) { let _ = self.view.set_visible(self.visible.get() && self.ready.get() && !self.temporarily_hidden.get()); }
    pub fn command(&self, action: &str) -> Result<(), String> {
        if !self.ready.get() { return Err("网页尚未完成安全初始化。".into()); }
        let core = self.view.webview();
        unsafe { match action { "back" => core.GoBack(), "forward" => core.GoForward(), "reload" => core.Reload(), _ => return Err("未知网页操作。".into()) } }.map_err(|_| "网页操作无法完成。".into())
    }
    #[cfg(debug_assertions)]
    fn container_visible(&self) -> bool {
        let mut parent = windows::Win32::Foundation::HWND::default();
        unsafe {
            if self.view.controller().ParentWindow(&mut parent).is_err() { return false; }
            use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_STYLE, WS_VISIBLE};
            GetWindowLongPtrW(parent.0, GWL_STYLE) as u32 & WS_VISIBLE != 0
        }
    }
}

/// Debug-only real WebView2 navigation acceptance; never touches an installed Core or user data.
#[cfg(debug_assertions)]
pub fn smoke(report: &Path) -> Result<(), String> {
    use tao::{event::Event, event_loop::{ControlFlow, EventLoopBuilder}, window::WindowBuilder};
    use std::time::{Duration, Instant};
    let event_loop = EventLoopBuilder::<Value>::with_user_event().build();
    let window = WindowBuilder::new().with_visible(false).with_inner_size(tao::dpi::LogicalSize::new(1200.0, 800.0)).build(&event_loop).map_err(|error| error.to_string())?;
    let proxy = event_loop.create_proxy();
    let notify = Rc::new(move |data| { let _ = proxy.send_event(data); });
    let parent = report.parent().ok_or("Missing smoke directory")?;
    let bounds = json!({"x":700,"y":100,"width":450,"height":650,"scale":window.scale_factor()});
    let mut browser = Some(ReferenceBrowser::new(&window, &parent.join("browser-profile"), "preview-smoke".into(), "https://example.com/".into(), &bounds, notify)?);
    browser.as_ref().unwrap().layout(&window, &bounds, true)?;
    let deadline = Instant::now() + Duration::from_secs(40);
    let output = report.to_path_buf(); let mut phase = 0;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::WaitUntil(deadline);
        let finish = |message: &str, flow: &mut ControlFlow| { let _ = std::fs::write(&output, message); *flow = ControlFlow::Exit; };
        match event {
            Event::UserEvent(data) if data["initialized"] == true => { if let Some(browser) = &browser { browser.reapply_visibility(); } }
            Event::UserEvent(data) if data["loading"] == false => {
                if data["error"].as_str().is_some_and(|error| !error.is_empty()) { browser.take(); finish(&format!("FAIL {}", data["error"]), flow); }
                else if data["title"].as_str().is_some_and(|title| title.contains("Example Domain")) {
                    if phase == 0 { phase = 1; if let Some(browser) = &browser { if !browser.container_visible() { finish("FAIL native browser container remained hidden after initialization", flow); } else { let _ = browser.view.evaluate_script("history.pushState({}, '', '#reference-smoke'); document.title='Reference Smoke State';"); } } }
                    else if phase == 2 { browser.take(); finish("PASS real WebView2 visible child container, HTTPS title, SPA source/title/history events, suspend/resume, reload and destruction", flow); }
                }
                else if phase == 1 && data["title"] == "Reference Smoke State" && data["url"].as_str().is_some_and(|url| url.ends_with("#reference-smoke")) {
                    if let Some(browser) = &browser { browser.hide(); if browser.container_visible() { finish("FAIL native child did not hide", flow); return; } browser.resume(); if !browser.container_visible() { finish("FAIL requested visibility not restored", flow); return; } phase = 2; if let Err(error) = browser.command("reload") { finish(&format!("FAIL {error}"), flow); } }
                }
            }
            Event::MainEventsCleared if Instant::now() >= deadline => { browser.take(); finish("FAIL real WebView2 navigation timed out", flow); }
            _ => {}
        }
    });
}
