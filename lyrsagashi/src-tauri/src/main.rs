#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent, Emitter};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
use tauri::menu::{Menu, MenuItem};
use std::env;
use std::sync::{Arc, Mutex};
use std::time::{Instant, Duration};
use std::thread;

fn oauth_bind_addr_from_redirect_uri() -> Option<String> {
    // Expected example: http://127.0.0.1:8888/callback
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

    // tiny_http binds TCP; "localhost" may resolve to IPv6 on some systems.
    // Bind explicitly to 127.0.0.1 when the redirect uses localhost.
    let host_port = if host_port.to_lowercase().starts_with("localhost:") {
        host_port.replacen("localhost:", "127.0.0.1:", 1)
    } else {
        host_port.to_string()
    };

    Some(host_port)
}

fn main() {
    // Ensure `.env` is loaded in dev so the Rust side
    // sees VITE_SPOTIFY_REDIRECT_URI too.
    let _ = dotenvy::dotenv();

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
            // Focus the running instance and show it 
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            use tauri_plugin_dialog::DialogExt;
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_shadow(false);

            // Spotify OAuth callback server
            let app_handle = app.handle().clone();
            let bind_addr = oauth_bind_addr_from_redirect_uri()
                .unwrap_or_else(|| "127.0.0.1:4381".to_string());
            let callback_url = format!("http://{bind_addr}/callback");

            let server = match tiny_http::Server::http(&bind_addr) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("Failed to start OAuth server: {e}");
                    app.dialog()
                        .message(format!(
                            "Lyricat couldn't start the local OAuth callback server at {callback_url}.\n\n\
Common causes:\n\
- Another app is using that port\n\
- Your security software is blocking local loopback\n\n\
Error: {e}\n\n\
Fix: change `VITE_SPOTIFY_REDIRECT_URI` to a different local port (and update it in the Spotify Developer Dashboard), then restart the app."
                        ))
                        .title("Spotify Login Failed")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(|_| {});
                    return Ok(());
                }
            };

            thread::spawn(move || {
                for request in server.incoming_requests() {
                    let url = request.url().to_string();
                    if url.starts_with("/callback") {
                        let code = url.split('?').nth(1).and_then(|qs| {
                            qs.split('&')
                                .find(|p| p.starts_with("code="))
                                .map(|p| p["code=".len()..].to_string())
                        });

                        if let Some(code) = code {
                            let html = "<html><body style='font-family:sans-serif;text-align:center;padding-top:80px'>\
                                <h2>Logged in!</h2><p>You can close this tab.</p></body></html>";
                            let response = tiny_http::Response::from_string(html)
                                .with_header("Content-Type: text/html".parse::<tiny_http::Header>().unwrap());
                            let _ = request.respond(response);
                            if let Some(win) = app_handle.get_webview_window("main") {
                                let _ = win.emit("spotify-code", code);
                            }
                        } else {
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

            // Tray icon: safe loading
            // Try the default window icon first; if missing, load from bundled PNG;
            // if that also fails, fall back to a tiny generated placeholder so we
            // never panic and the tray is always created.
            let tray_icon = app.default_window_icon()
                .cloned()
                .or_else(|| {
                    // Try loading from the bundled icon file
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
                    // Last-resort: a 4×4 solid red placeholder so the tray still appears
                    let rgba: Vec<u8> = (0..16).flat_map(|_| [200u8, 50, 50, 255]).collect();
                    tauri::image::Image::new_owned(rgba, 4, 4)
                });

            TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .show_menu_on_left_click(false)   // left click shows widget, not menu
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