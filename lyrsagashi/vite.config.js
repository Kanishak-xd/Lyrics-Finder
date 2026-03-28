import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"

// base: "./" — bundled CSS/JS use ./assets/... so Tauri's WebView resolves them (not "/assets/...").
// Tailwind is compiled into the CSS chunk at build time — no runtime CDN required.
export default defineConfig({
  base: "./",
  envPrefix: "VITE_",
  plugins: [tailwindcss()],
})