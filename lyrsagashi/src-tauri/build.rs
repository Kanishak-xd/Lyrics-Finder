fn main() {
    // Keep Rust OAuth callback bind address in sync with frontend Vite env.
    let _ = dotenvy::from_filename("../.env");
    if let Ok(uri) = std::env::var("VITE_SPOTIFY_REDIRECT_URI") {
        println!("cargo:rustc-env=SPOTIFY_REDIRECT_URI={uri}");
    }
    println!("cargo:rerun-if-changed=../.env");
    tauri_build::build()
}
