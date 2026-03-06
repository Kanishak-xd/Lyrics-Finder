#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
use std::sync::{Arc, Mutex};
use std::time::{Instant, Duration};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_shadow(false);

            // Stores the instant when show() was last called.
            // Blur events within 300ms of showing are ignored — they are
            // always OS focus-handoff artifacts from the tray click, not
            // genuine "user clicked elsewhere" events.
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

                    // Only hide if we've been shown for more than 300ms
                    if elapsed > Duration::from_millis(300) {
                        drop(guard);
                        let _ = win_clone.hide();
                    }
                }
            });

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

                        // Toggle: if visible AND shown more than 300ms ago, hide it
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

                        // Center widget over tray icon, clamped to screen edges
                        let screen_width = window.current_monitor()
                            .ok().flatten()
                            .map(|m| m.size().width as i32)
                            .unwrap_or(1920);
                        let widget_w = 290_i32;
                        let x = (position.x as i32 - widget_w / 2)
                            .max(0)
                            .min(screen_width - widget_w);
                        let y = position.y as i32 - 260 - 8;

                        // Tell JS where the tray icon is relative to the widget
                        // so the caret can point exactly at it
                        let tray_x_in_widget = position.x as i32 - x;

                        let _ = window.set_position(
                            tauri::Position::Physical(
                                tauri::PhysicalPosition { x, y }
                            )
                        );

                        // Record show time BEFORE show() so the blur handler
                        // sees a valid timestamp immediately
                        *shown_at_tray.lock().unwrap() = Some(Instant::now());
                        let _ = window.show();
                        let _ = window.set_focus();
                        // Move caret to point at tray icon
                        let js = format!("window.setCaret({})", tray_x_in_widget);
                        let _ = window.eval(&js);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}