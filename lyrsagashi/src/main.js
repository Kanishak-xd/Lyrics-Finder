import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();

// "blur" fires when the entire OS window loses focus —
// not when focus moves between elements inside it.
// This is what you want for a tray popup.
window.addEventListener("blur", () => {
  win.hide();
});