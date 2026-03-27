#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent, Emitter, State};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
use tauri::menu::{Menu, MenuItem};
use std::env;
use std::sync::{Arc, Mutex};
use std::time::{Instant, Duration};
use std::thread;
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;

struct AppState {
    oauth_port: Mutex<u16>,
    oauth_ack: Mutex<bool>,
}

fn log_to_file(message: &str) {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let dir = format!("{}\\Lyricat", base);
    let _ = create_dir_all(&dir);
    let path = format!("{}\\logs.txt", dir);

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", message);
    }
}

#[tauri::command]
fn log_message(message: String) {
    log_to_file(&format!("[JS] {}", message));
}

#[tauri::command]
fn get_oauth_port(state: State<'_, AppState>) -> u16 {
    *state.oauth_port.lock().unwrap()
}

#[tauri::command]
fn ack_oauth_received(state: State<'_, AppState>) {
    *state.oauth_ack.lock().unwrap() = true;
    log_to_file("Frontend acknowledged OAuth code");
}

#[tauri::command]
fn read_oauth_code() -> Option<String> {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let path = format!("{}\\Lyricat\\oauth_code.txt", base);
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

#[tauri::command]
fn clear_oauth_code() {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let path = format!("{}\\Lyricat\\oauth_code.txt", base);
    let _ = std::fs::remove_file(path);
    log_to_file("Cleared oauth_code.txt");
}

fn oauth_bind_addr_from_redirect_uri() -> Option<String> {
    let uri = env::var("VITE_SPOTIFY_REDIRECT_URI")
        .ok()
        .or_else(|| option_env!("SPOTIFY_REDIRECT_URI").map(|s| s.to_string()))?;
    let without_scheme = uri
        .strip_prefix("http://")
        .or_else(|| uri.strip_prefix("https://"))?
        .to_string();

    let host_port = without_scheme.split('/').next()?.trim();
    if host_port.is_empty() {
        return None;
    }

    let host_port = if host_port.to_lowercase().starts_with("localhost:") {
        host_port.replacen("localhost:", "127.0.0.1:", 1)
    } else {
        host_port.to_string()
    };

    Some(host_port)
}

fn main() {
    let _ = dotenvy::dotenv();

    log_to_file("===============================");
    log_to_file("App started");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri_plugin_dialog::DialogExt;
            app.dialog()
                .message("Only one instance of app is allowed to run at a time.\nLyricat is already running, you can access it from your system tray.")
                .title("Lyricat is Already Running")
                .kind(tauri_plugin_dialog::MessageDialogKind::Info)
                .show(|_| {});
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            log_message,
            get_oauth_port,
            ack_oauth_received,
            read_oauth_code,
            clear_oauth_code
        ])
        .setup(|app| {
            use tauri_plugin_dialog::DialogExt;
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_shadow(false);

            // Spotify OAuth callback server
            let app_handle = app.handle().clone();
            
            // Extract the original host (e.g., 127.0.0.1) from env or use default.
            let bind_addr = oauth_bind_addr_from_redirect_uri()
                .unwrap_or_else(|| "127.0.0.1:4381".to_string());
            let hostname = bind_addr.split(':').next().unwrap_or("127.0.0.1").to_string();

            // Fallback ports
            let ports = vec![4381, 4382, 4383];
            let mut bound_server = None;

            for port in &ports {
                let addr = format!("{}:{}", hostname, port);
                match tiny_http::Server::http(&addr) {
                    Ok(s) => {
                        log_to_file(&format!("Bound OAuth server to {}", addr));
                        bound_server = Some((s, *port));
                        break;
                    }
                    Err(e) => {
                        log_to_file(&format!("Failed to bind port {}: {}", port, e));
                    }
                }
            }

            let (server, bound_port) = match bound_server {
                Some(s) => s,
                None => {
                    let e_msg = format!(
                        "Lyricat couldn't start the local OAuth callback server.\n\n\
Tried ports: {:?}\n\
Common causes:\n\
- Another app is using those ports\n\
- Your security software is blocking local loopback\n\n\
Fix: free up port 4381/4382 and restart the app.",
                        ports
                    );
                    log_to_file("Failed to bind any OAuth server ports.");
                    app.dialog()
                        .message(&e_msg)
                        .title("Spotify Login Failed")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(|_| {});
                    return Ok(());
                }
            };

            // Manage the global state
            app.manage(AppState {
                oauth_port: Mutex::new(bound_port),
                oauth_ack: Mutex::new(false),
            });

            thread::spawn(move || {
                for request in server.incoming_requests() {
                    let url = request.url().to_string();
                    if url.starts_with("/callback") {
                        let code = url.split('?').nth(1).and_then(|qs| {
                            url::form_urlencoded::parse(qs.as_bytes())
                                .find(|(k, _)| k == "code")
                                .map(|(_, v)| v.into_owned())
                        });

                        if let Some(code) = code {
                            let code = code.trim().to_string();
                            log_to_file("OAuth callback received code");

                            // Store to file persistently
                            let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
                            let dir = format!("{}\\Lyricat", base);
                            let _ = create_dir_all(&dir);
                            let path = format!("{}\\oauth_code.txt", dir);
                            let _ = std::fs::write(&path, &code);
                            log_to_file("Stored OAuth code to file");

                            let html = "<html><body style='font-family:sans-serif;text-align:center;padding-top:80px'>\
                                <h2>Logged in!</h2><p>You can close this tab.</p></body></html>";
                            let response = tiny_http::Response::from_string(html)
                                .with_header("Content-Type: text/html".parse::<tiny_http::Header>().unwrap());
                            let _ = request.respond(response);

                            let state = app_handle.state::<AppState>();
                            *state.oauth_ack.lock().unwrap() = false; // Reset ack for a new emit

                            if let Some(win) = app_handle.get_webview_window("main") {
                                // Show and focus BEFORE emitting
                                let _ = win.show();
                                let _ = win.set_focus();

                                // Emit retry loop
                                for i in 0..5 {
                                    if *state.oauth_ack.lock().unwrap() {
                                        log_to_file("OAuth code acknowledged by frontend. Stopping emit loop.");
                                        break;
                                    }
                                    log_to_file(&format!("Emitting spotify-code attempt {}", i + 1));
                                    let _ = win.emit("spotify-code", code.clone());
                                    thread::sleep(Duration::from_millis(200));
                                }
                            }
                        } else {
                            log_to_file("OAuth callback received request, but missing code");
                            let _ = request.respond(
                                tiny_http::Response::from_string("Missing code").with_status_code(400)
                            );
                        }
                    } else {
                        let _ = request.respond(
                            tiny_http::Response::from_string("Not found").with_status_code(404)
                        );
                    }
                }
            });

            // Focus / hide logic
            let shown_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
            let shown_at_event = shown_at.clone();
            let shown_at_tray  = shown_at.clone();

            let win_clone = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let guard = shown_at_event.lock().unwrap();
                    let elapsed = guard.map(|t| t.elapsed()).unwrap_or(Duration::from_secs(999));
                    if elapsed > Duration::from_millis(300) {
                        drop(guard);
                        let _ = win_clone.hide();
                    }
                }
            });

            // Right-click context menu
            let signout_item = MenuItem::with_id(app, "signout", "Sign Out", true, None::<&str>)?;
            let close_item = MenuItem::with_id(app, "quit", "Close Lyricat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&signout_item, &close_item])?;

            let tray_icon = app.default_window_icon()
                .cloned()
                .or_else(|| {
                    let resource_path = app.path().resource_dir()
                        .ok()
                        .map(|d| d.join("icons/32x32.png"));
                    resource_path.and_then(|p| {
                        std::fs::read(&p).ok().and_then(|bytes| {
                            image::load_from_memory(&bytes).ok().map(|img| {
                                let rgba = img.into_rgba8();
                                let (width, height) = rgba.dimensions();
                                tauri::image::Image::new_owned(rgba.into_raw(), width, height)
                            })
                        })
                    })
                })
                .unwrap_or_else(|| {
                    let rgba: Vec<u8> = (0..16).flat_map(|_| [200u8, 50, 50, 255]).collect();
                    tauri::image::Image::new_owned(rgba, 4, 4)
                });

            TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "quit" {
                        app.exit(0);
                    } else if event.id().as_ref() == "signout" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.signOut();");
                        }
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        position,
                        ..
                    } = event {
                        let window = tray.app_handle().get_webview_window("main").unwrap();

                        if window.is_visible().unwrap_or(false) {
                            let elapsed = shown_at_tray.lock().unwrap()
                                .map(|t| t.elapsed())
                                .unwrap_or(Duration::from_secs(999));
                            if elapsed > Duration::from_millis(300) {
                                *shown_at_tray.lock().unwrap() = None;
                                let _ = window.hide();
                            }
                            return;
                        }

                        let screen_width = window.current_monitor()
                            .ok().flatten()
                            .map(|m| m.size().width as i32)
                            .unwrap_or(1920);
                        let widget_w = 290_i32;
                        let x = (position.x as i32 - widget_w / 2).max(0).min(screen_width - widget_w);
                        let y = position.y as i32 - 260 - 8;
                        let tray_x_in_widget = position.x as i32 - x;

                        let _ = window.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition { x, y }
                        ));

                        *shown_at_tray.lock().unwrap() = Some(Instant::now());
                        let _ = window.show();
                        let _ = window.set_focus();
                        let js = format!("window.setCaret({}); window.fetchTrack();", tray_x_in_widget);
                        let _ = window.eval(&js);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}