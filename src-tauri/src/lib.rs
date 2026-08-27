use std::{
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command},
    sync::Mutex,
    time::Duration,
};

#[cfg(windows)]
fn acquire_single_instance() -> bool {
    use std::ffi::c_void;
    use std::ptr::null_mut;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *mut c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
        fn GetLastError() -> u32;
    }
    let name: Vec<u16> = "Local\\StockWidgetTray\0".encode_utf16().collect();
    let handle = unsafe { CreateMutexW(null_mut(), 1, name.as_ptr()) };
    if handle.is_null() || unsafe { GetLastError() } == 183 {
        return false;
    }
    // Keep the named mutex alive until process exit.
    let _ = handle;
    true
}

#[cfg(not(windows))]
fn acquire_single_instance() -> bool { true }
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    LogicalSize, Manager, PhysicalPosition, RunEvent, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

struct BridgeProcess(Mutex<Option<Child>>);

fn quote_bridge_is_running() -> bool {
    let address: SocketAddr = "127.0.0.1:8765"
        .parse()
        .expect("valid quote bridge address");
    TcpStream::connect_timeout(&address, Duration::from_millis(120)).is_ok()
}

fn start_quote_bridge(app: &tauri::AppHandle) -> Option<Child> {
    if quote_bridge_is_running() {
        return None;
    }

    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("resources/server.py"));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/server.py");
    let script = bundled
        .into_iter()
        .chain([development])
        .find(|path| path.exists());

    let Some(script) = script else {
        eprintln!("[stock-widget] server.py not found; start it manually on port 8765");
        return None;
    };

    let mut command = Command::new("python");
    command.arg(script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    match command.spawn() {
        Ok(child) => Some(child),
        Err(error) => { eprintln!("[stock-widget] could not start quote bridge: {error}"); None }
    }
}

fn place_near_taskbar(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let Ok(window_size) = window.outer_size() else {
        return;
    };
    let monitor_size = monitor.size();
    let monitor_position = monitor.position();
    let x = monitor_position.x + monitor_size.width as i32 - window_size.width as i32 - 12;
    let y = monitor_position.y + monitor_size.height as i32 - window_size.height as i32 - 60;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            place_near_taskbar(&window);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_window(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window
        .set_size(LogicalSize::new(430.0, height.clamp(250.0, 680.0)))
        .map_err(|error| error.to_string())?;
    place_near_taskbar(&window);
    Ok(())
}

#[tauri::command]
fn send_notification(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !acquire_single_instance() {
        return;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(BridgeProcess(Mutex::new(start_quote_bridge(app.handle()))));
            if let Some(window) = app.get_webview_window("main") {
                place_near_taskbar(&window);
            }
            let show = MenuItemBuilder::with_id("show", "显示看盘").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("default icon is configured"),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => toggle_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(&tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![hide_window, resize_window, send_notification])
        .build(tauri::generate_context!())
        .expect("error while building stock widget");
    app.run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<BridgeProcess>() {
                    if let Ok(mut child) = state.0.lock() {
                        if let Some(mut process) = child.take() { let _ = process.kill(); }
                    }
                }
            }
        });
}
