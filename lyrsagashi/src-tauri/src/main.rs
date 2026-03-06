#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::tray::MouseButton;

fn main() {
    tauri::Builder::default()
        .setup(|app| {

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

                        // Center widget horizontally over tray icon (widget is 290px wide)
                        let x = position.x as i32 - 145;
                        // Place widget above tray icon (widget is 299px tall, +8px gap)
                        let y = position.y as i32 - 299 - 8;

                        let _ = window.set_position(
                            tauri::Position::Physical(
                                tauri::PhysicalPosition { x, y }
                            )
                        );

                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}