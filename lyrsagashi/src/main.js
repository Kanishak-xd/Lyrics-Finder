import "./styles.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const clientId    = "a5507c40cbf843219626ad3b1e205254";
const redirectUri = "http://127.0.0.1:8888/callback";

const win = getCurrentWindow();

let currentSong   = "";
let currentArtist = "";
let buttons;

// Auth helpers

function generateRandomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < length; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
  return r;
}

async function sha256(plain) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
}

function base64urlencode(a) {
  return btoa(String.fromCharCode(...new Uint8Array(a)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function loginSpotify() {
  const verifier  = generateRandomString(64);
  localStorage.setItem("spotify_code_verifier", verifier);
  const challenge = base64urlencode(await sha256(verifier));
  const params = new URLSearchParams({
    response_type: "code", client_id: clientId,
    scope: "user-read-currently-playing user-read-playback-state",
    redirect_uri: redirectUri, code_challenge_method: "S256", code_challenge: challenge,
  });
  await openUrl(`https://accounts.spotify.com/authorize?${params}`);
}

async function exchangeToken(code) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, grant_type: "authorization_code", code,
      redirect_uri: redirectUri,
      code_verifier: localStorage.getItem("spotify_code_verifier"),
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
      client_id: clientId, grant_type: "refresh_token", refresh_token: refresh,
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

// Synced marquee

let marqueeFrame = null;

function stopMarquee() {
  if (marqueeFrame) { cancelAnimationFrame(marqueeFrame); marqueeFrame = null; }
}

function startMarquee(songEl, artistEl) {
  stopMarquee();
  songEl.style.transform   = "translateX(0)";
  artistEl.style.transform = "translateX(0)";

  const ovA = Math.max(0, songEl.scrollWidth   - songEl.parentElement.clientWidth);
  const ovB = Math.max(0, artistEl.scrollWidth - artistEl.parentElement.clientWidth);
  const maxOv = Math.max(ovA, ovB);
  if (maxOv <= 2) return;
  const pxPerSec = 40;
  const travelMs = (maxOv / pxPerSec) * 1000; 
  const pauseMs  = 1400;

  let phase     = "pause-start";
  let startTime = null;

  function tick(now) {
    if (!startTime) startTime = now;
    const elapsed = now - startTime;
    let t = 0;

    if (phase === "pause-start") {
      if (elapsed >= pauseMs) { phase = "scroll-left"; startTime = now; }

    } else if (phase === "scroll-left") {
      t = Math.min(elapsed / travelMs, 1);
      songEl.style.transform   = `translateX(${-Math.min(ovA, maxOv * t)}px)`;
      artistEl.style.transform = `translateX(${-Math.min(ovB, maxOv * t)}px)`;
      if (t >= 1) { phase = "pause-end"; startTime = now; }

    } else if (phase === "pause-end") {
      songEl.style.transform   = `translateX(${-ovA}px)`;
      artistEl.style.transform = `translateX(${-ovB}px)`;
      if (elapsed >= pauseMs) { phase = "scroll-right"; startTime = now; }

    } else if (phase === "scroll-right") {
      t = Math.min(elapsed / travelMs, 1);
      songEl.style.transform   = `translateX(${-Math.max(0, ovA   - maxOv * t)}px)`;
      artistEl.style.transform = `translateX(${-Math.max(0, ovB   - maxOv * t)}px)`;
      if (t >= 1) { phase = "pause-start"; startTime = now; }
    }

    marqueeFrame = requestAnimationFrame(tick);
  }

  marqueeFrame = requestAnimationFrame(tick);
}

function updateDisplay(song, artist) {
  const songEl   = document.getElementById("song");
  const artistEl = document.getElementById("artist");
  songEl.textContent   = song;
  artistEl.textContent = artist;
  requestAnimationFrame(() => requestAnimationFrame(() => startMarquee(songEl, artistEl)));
}

// Spotify fetch
async function fetchTrack() {
  try {
    const token = localStorage.getItem("spotify_token");
    if (!token) { await loginSpotify(); return; }

    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 204) {
      updateDisplay("Nothing playing", "Open Spotify and play something");
      buttons.forEach(b => (b.disabled = true));
      return;
    }
    if (res.status === 401) {
      if (await refreshToken()) return fetchTrack();
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

// Init
window.addEventListener("DOMContentLoaded", async () => {
  buttons = document.querySelectorAll("button");
  buttons.forEach(b => (b.disabled = true));

  await listen("spotify-code", async (e) => exchangeToken(e.payload));

  window.fetchTrack = fetchTrack;
});

// on btn click open in system browser + close widget
window.openLyrics = async function(site) {
  if (!currentSong) return;

  const q    = encodeURIComponent(`${currentSong} ${currentArtist}`);
  const qRom = encodeURIComponent(`${currentSong} ${currentArtist} romanized`);

  const urls = {
    genius:     `https://genius.com/search?q=${qRom}`,
    colorcoded: `https://colorcodedlyrics.com/?s=${qRom}`,
    az:         `https://www.google.com/search?q=site:azlyrics.com+${q}`,
    musixmatch: `https://www.musixmatch.com/search?query=${qRom}`,
  };

  await openUrl(urls[site]);
  await win.hide();
};