import "./styles.css";
import { open } from "@tauri-apps/plugin-shell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const clientId    = "a5507c40cbf843219626ad3b1e205254";
const redirectUri = "http://127.0.0.1:8888/callback";

const win = getCurrentWindow();

let currentSong   = "";
let currentArtist = "";
let buttons;

function buildQuery() {
  return encodeURIComponent(`${currentSong} ${currentArtist}`);
}

function generateRandomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

async function sha256(plain) {
  const data = new TextEncoder().encode(plain);
  return await crypto.subtle.digest("SHA-256", data);
}

function base64urlencode(a) {
  return btoa(String.fromCharCode(...new Uint8Array(a)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function loginSpotify() {
  const verifier = generateRandomString(64);
  localStorage.setItem("spotify_code_verifier", verifier);
  const hashed   = await sha256(verifier);
  const challenge = base64urlencode(hashed);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "user-read-currently-playing user-read-playback-state",
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  await openUrl(`https://accounts.spotify.com/authorize?${params.toString()}`);
}

async function exchangeToken(code) {
  const verifier = localStorage.getItem("spotify_code_verifier");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    localStorage.setItem("spotify_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("spotify_refresh_token", data.refresh_token);
    await fetchTrack();
  } else {
    console.error("Token exchange failed:", data);
  }
}

async function refreshToken() {
  const refresh = localStorage.getItem("spotify_refresh_token");
  if (!refresh) return false;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    localStorage.setItem("spotify_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("spotify_refresh_token", data.refresh_token);
    return true;
  }
  return false;
}

// ── Marquee scroll ────────────────────────────────────────────────────────────
// Spotify-style: pause → scroll left → pause → scroll right → loop
function setupMarquee(el) {
  // Reset any previous animation
  el.style.animation = "none";
  el.style.transform = "translateX(0)";

  const parent    = el.parentElement;
  const overflow  = el.scrollWidth - parent.clientWidth;

  // No overflow — plain truncation is fine
  if (overflow <= 2) return;

  el.style.whiteSpace    = "nowrap";
  el.style.display       = "inline-block";
  el.style.willChange    = "transform";

  const pxPerSec  = 40;          // scroll speed
  const travelMs  = (overflow / pxPerSec) * 1000;
  const pauseMs   = 1200;        // pause at each end

  let frame;
  let startTime;
  let phase = "pause-start";    // pause-start → scroll-left → pause-end → scroll-right → loop

  function tick(now) {
    if (!startTime) startTime = now;
    const elapsed = now - startTime;

    if (phase === "pause-start") {
      if (elapsed >= pauseMs) { phase = "scroll-left"; startTime = now; }
    } else if (phase === "scroll-left") {
      const progress = Math.min(elapsed / travelMs, 1);
      el.style.transform = `translateX(${-overflow * progress}px)`;
      if (progress >= 1) { phase = "pause-end"; startTime = now; }
    } else if (phase === "pause-end") {
      if (elapsed >= pauseMs) { phase = "scroll-right"; startTime = now; }
    } else if (phase === "scroll-right") {
      const progress = Math.min(elapsed / travelMs, 1);
      el.style.transform = `translateX(${-overflow * (1 - progress)}px)`;
      if (progress >= 1) { phase = "pause-start"; startTime = now; }
    }

    frame = requestAnimationFrame(tick);
  }

  frame = requestAnimationFrame(tick);

  // Return cleanup fn
  return () => cancelAnimationFrame(frame);
}

let cleanupSong   = null;
let cleanupArtist = null;

function updateDisplay(song, artist) {
  const songEl   = document.getElementById("song");
  const artistEl = document.getElementById("artist");

  songEl.textContent   = song;
  artistEl.textContent = artist;

  // Clean up previous animations
  if (cleanupSong)   cleanupSong();
  if (cleanupArtist) cleanupArtist();

  // Small delay so layout is calculated after text update
  requestAnimationFrame(() => {
    cleanupSong   = setupMarquee(songEl)   || null;
    cleanupArtist = setupMarquee(artistEl) || null;
  });
}

// ── Spotify fetch ─────────────────────────────────────────────────────────────
async function fetchTrack() {
  try {
    const token = localStorage.getItem("spotify_token");
    if (!token) { await loginSpotify(); return; }

    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 204) {
      updateDisplay("Nothing playing", "Open Spotify and play something");
      return;
    }
    if (res.status === 401) {
      const refreshed = await refreshToken();
      if (refreshed) return fetchTrack();
      localStorage.removeItem("spotify_token");
      await loginSpotify();
      return;
    }
    if (!res.ok) { await loginSpotify(); return; }

    const data    = await res.json();
    currentSong   = data.item.name;
    currentArtist = data.item.artists.map(a => a.name).join(", ");

    updateDisplay(currentSong, currentArtist);
    buttons.forEach(b => (b.disabled = false));

  } catch (err) {
    console.error("Spotify fetch failed:", err);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  buttons = document.querySelectorAll("button");
  buttons.forEach(b => (b.disabled = true));

  await listen("spotify-code", async (event) => {
    await exchangeToken(event.payload);
  });

  window.fetchTrack = fetchTrack;
});

// ── Open lyrics in default browser + close widget ────────────────────────────
window.openLyrics = async function (site) {
  if (!currentSong) return;
  const q = buildQuery();

  // Append "romanized" to the query for sites that support it
  const qRom = encodeURIComponent(`${currentSong} ${currentArtist} romanized`);

  const urls = {
    genius:     `https://genius.com/search?q=${qRom}`,
    colorcoded: `https://colorcodedlyrics.com/?s=${qRom}`,
    az:         `https://search.azlyrics.com/search.php?q=${q}`,       // AZ doesn't have romanized
    musixmatch: `https://www.musixmatch.com/search/${qRom}`,
  };

  // Open in system default browser
  await open(urls[site]);

  // Close the widget
  await win.hide();
};