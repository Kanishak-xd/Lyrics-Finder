<p align="left">
  <img src="https://img.shields.io/badge/Tauri-FFC131?style=for-the-badge&logo=tauri&logoColor=black"/>
  <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white"/>
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=FFD62E"/>
  <img src="https://img.shields.io/badge/TailwindCSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white"/>
  <img src="https://img.shields.io/badge/Spotify%20API-1DB954?style=for-the-badge&logo=spotify&logoColor=white"/>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black"/>
</p>

# LyricSagashii

**LyricSagashii** is a lightweight desktop tray utility that instantly finds lyrics for the song currently playing on Spotify.

Instead of manually searching lyrics every time, LyricSagashii detects your currently playing Spotify track and opens the lyrics on your preferred site with a single click.

Designed to be **fast, minimal, and unobtrusive**, it lives quietly in the system tray and appears only when you need it.

---

## Features

- **Spotify Now Playing Detection**  
  Fetches the currently playing track directly from the Spotify Web API.

- **One-Click Lyrics Search**  
  Instantly open lyrics on popular websites:
  - Genius
  - ColorCodedLyrics
  - AZLyrics
  - Musixmatch

- **Tray-Based Workflow**  
  - Runs quietly in the system tray  
  - Opens a compact widget when left clicked
  - Right click to show menu to close application
  - Automatically hides when focus is lost

- **Zero Background Polling**  
  Spotify API is queried **only when the widget is opened**, keeping CPU and network usage minimal.

- **Smart Lyrics Query Builder**  
  Automatically formats song + artist names for accurate lyric searches.

- **Native Desktop Experience**  
  Built with Tauri for small bundle size and native performance.

- **Modern UI**  
  Clean widget-style interface with TailwindCSS.

No background services. No unnecessary resource usage.

---

## Tech Stack

**Frontend**
- JavaScript
- Vite
- TailwindCSS

**Desktop Runtime**
- Tauri
- Rust

**APIs**
- Spotify Web API

---

## Spotify Authentication

LyricSagashii uses the **Spotify Authorization Code Flow with PKCE**.

Permissions requested:
user-read-currently-playing
user-read-playback-state
Authentication occurs only once, and the access token is stored locally.

---

## Installation (Development)

Clone the repository:

```
git clone https://github.com/Kanishak-xd/lyrsagashi.git
cd lyrsagashi
```
Install dependencies:
```
npm install
```
Run the development build:
```
npm run tauri dev
```

## Environment Variables
Create a .env file in the project root:
```
VITE_SPOTIFY_CLIENT_ID=your_spotify_client_id
VITE_SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```
You must also configure the same redirect URI in the Spotify Developer Dashboard.