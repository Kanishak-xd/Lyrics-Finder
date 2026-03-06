#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent, Emitter};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
use std::sync::{Arc, Mutex};
use std::time::{Instant, Duration};
use std::thread;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_shadow(false);

            // ── Spotify OAuth callback server ─────────────────────────────
            // Listens on 127.0.0.1:8888, waits for GET /callback?code=...
            // then emits "spotify-code" to the webview so JS can exchange it.
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                let server = match tiny_http::Server::http("127.0.0.1:8888") {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("Failed to start OAuth server: {e}");
                        return;
                    }
                };

                for request in server.incoming_requests() {
                    let url = request.url().to_string();

                    if url.starts_with("/callback") {
                        let code = url
                            .split('?')
                            .nth(1)
                            .and_then(|qs| {
                                qs.split('&')
                                    .find(|p| p.starts_with("code="))
                                    .map(|p| p["code=".len()..].to_string())
                            });

                        if let Some(code) = code {
                            let html = "<html><body style='font-family:sans-serif;text-align:center;padding-top:80px'>\
                                <h2>&#x2705; Logged in!</h2><p>You can close this tab.</p></body></html>";
                            let response = tiny_http::Response::from_string(html)
                                .with_header(
                                    "Content-Type: text/html"
                                        .parse::<tiny_http::Header>()
                                        .unwrap(),
                                );
                            let _ = request.respond(response);

                            if let Some(win) = app_handle.get_webview_window("main") {
                                let _ = win.emit("spotify-code", code);
                            }
                        } else {
                            let _ = request.respond(
                                tiny_http::Response::from_string("Missing code parameter")
                                    .with_status_code(400),
                            );
                        }
                    } else {
                        let _ = request.respond(
                            tiny_http::Response::from_string("Not found")
                                .with_status_code(404),
                        );
                    }
                }
            });

            // ── Focus / hide logic ────────────────────────────────────────
            let shown_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
            let shown_at_event = shown_at.clone();
            let shown_at_tray  = shown_at.clone();

            let win_clone = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let guard = shown_at_event.lock().unwrap();
                    let elapsed = guard
                        .map(|t| t.elapsed())
                        .unwrap_or(Duration::from_secs(999));
                    if elapsed > Duration::from_millis(300) {
                        drop(guard);
                        let _ = win_clone.hide();
                    }
                }
            });

            // ── Tray icon ─────────────────────────────────────────────────
            TrayIconBuilder::new()
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        position,
                        ..
                    } = event {
                        let window = tray.app_handle()
                            .get_webview_window("main")
                            .unwrap();

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
                        let x = (position.x as i32 - widget_w / 2)
                            .max(0)
                            .min(screen_width - widget_w);
                        let y = position.y as i32 - 260 - 8;
                        let tray_x_in_widget = position.x as i32 - x;

                        let _ = window.set_position(
                            tauri::Position::Physical(
                                tauri::PhysicalPosition { x, y }
                            )
                        );

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