import "./styles.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
const redirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI;

const win = getCurrentWindow();

let romanizedEnabled = true;
let currentSong      = "";
let currentArtist    = "";
let buttons;

// UI state helpers
function showMain() {
  document.getElementById("mainCard").classList.remove("hidden");
  document.getElementById("loginCard").classList.add("hidden");
}

function showLogin() {
  document.getElementById("loginCard").classList.remove("hidden");
  document.getElementById("mainCard").classList.add("hidden");
}

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
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build the Spotify auth URL (without opening the browser). */
async function buildAuthUrl() {
  const verifier  = generateRandomString(64);
  localStorage.setItem("spotify_code_verifier", verifier);
  const challenge = base64urlencode(await sha256(verifier));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "user-read-currently-playing user-read-playback-state",
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function loginSpotify() {
  const url = await buildAuthUrl();
  await openUrl(url);
}

async function exchangeToken(code) {
  const verifier = localStorage.getItem("spotify_code_verifier");
  if (!verifier) {
    console.error("Missing PKCE verifier; restarting login flow.");
    await showLoginScreen();
    return;
  }

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
    showMain();
    await fetchTrack();
  } else {
    console.error("Token exchange failed:", data);
    // Force a clean retry if Spotify rejected the code/verifier pair.
    localStorage.removeItem("spotify_code_verifier");
    await showLoginScreen();
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

// Synced marquee
let marqueeFrame = null;

function stopMarquee() {
  if (marqueeFrame) { cancelAnimationFrame(marqueeFrame); marqueeFrame = null; }
}

function startMarquee(songEl, artistEl) {
  stopMarquee();
  songEl.style.transform   = "translateX(0)";
  artistEl.style.transform = "translateX(0)";

  const ovA   = Math.max(0, songEl.scrollWidth   - songEl.parentElement.clientWidth);
  const ovB   = Math.max(0, artistEl.scrollWidth - artistEl.parentElement.clientWidth);
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
      songEl.style.transform   = `translateX(${-Math.max(0, ovA - maxOv * t)}px)`;
      artistEl.style.transform = `translateX(${-Math.max(0, ovB - maxOv * t)}px)`;
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
    if (!token) {
      // No token — show the sign-in screen instead of silently popping browser
      await showLoginScreen();
      return;
    }

    showMain();

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
      await showLoginScreen();
      return;
    }
    if (!res.ok) { await showLoginScreen(); return; }

    const data    = await res.json();
    currentSong   = data.item.name;
    currentArtist = data.item.artists.map(a => a.name).join(", ");
    updateDisplay(currentSong, currentArtist);
    buttons.forEach(b => (b.disabled = false));

  } catch (err) {
    console.error("Spotify fetch failed:", err);
  }
}

// First-run login screen
/**
 * Shows the sign-in panel, builds the auth URL, populates the fallback link,
 * and opens the browser automatically so the user just has to approve.
 */
async function showLoginScreen() {
  showLogin();

  // Build the URL first (stores the verifier in localStorage for later exchange)
  const url = await buildAuthUrl();

  // Set up the copy link button
  const copyBtn = document.getElementById("authLinkBtn");
  const copyText = document.getElementById("authLinkText");
  if (copyBtn && copyText) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        copyText.textContent = "Copied!";
        copyBtn.style.color = "#1DB954";
        copyBtn.querySelector('svg').style.color = "#1DB954";
        copyBtn.querySelector('svg').style.opacity = "1";
        setTimeout(() => {
          copyText.textContent = "Copy login link";
          copyBtn.style.color = "rgba(30,20,10,0.6)";
          copyBtn.querySelector('svg').style.color = "currentColor";
          copyBtn.querySelector('svg').style.opacity = "0.6";
        }, 2000);
      } catch (e) {
        console.error("Failed to copy", e);
      }
    };
  }

  // Wire up the sign-in button
  const btn = document.getElementById("spotifySignInBtn");
  if (btn) {
    // Replace onclick so we use the same URL (verifier already stored)
    btn.onclick = () => openUrl(url);
  }

}

// Init
window.addEventListener("DOMContentLoaded", async () => {
  // Prevent the embedded webview context menu (Refresh/Save/Print) from
  // showing up when the user right-clicks while the widget is open.
  // The tray menu is handled by Rust and should be the only menu.
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  const toggle = document.getElementById("romanToggle");
  const track  = document.getElementById("romanTrack");
  const thumb  = document.getElementById("romanThumb");

  function updateToggleUI() {
    if (romanizedEnabled) {
      track.style.background  = "#FF6B6B";
      thumb.style.transform   = "translateX(12px)";
    } else {
      track.style.background  = "rgba(0,0,0,0.15)";
      thumb.style.transform   = "translateX(0)";
    }
  }

    toggle.addEventListener("change", (e) => {
        romanizedEnabled = e.target.checked;
        updateToggleUI();
    });

  updateToggleUI();

  buttons = document.querySelectorAll("#mainCard button");
  buttons.forEach(b => (b.disabled = true));

  await listen("spotify-code", async (e) => {
    const rawCode = String(e.payload ?? "");
    const code = (() => {
      try {
        return decodeURIComponent(rawCode);
      } catch {
        return rawCode;
      }
    })();
    await exchangeToken(code);
  });

  // Expose for Rust to call
  window.fetchTrack     = fetchTrack;
  window.showLoginScreen = showLoginScreen;
  window.signOut = () => {
    localStorage.removeItem("spotify_token");
    localStorage.removeItem("spotify_refresh_token");
    buttons.forEach(b => (b.disabled = true));
    showLoginScreen();
  };
});

// Open lyrics
window.openLyrics = async function(site) {
  if (!currentSong) return;

  const baseQuery = `${currentSong} ${currentArtist}`;

  const finalQuery = romanizedEnabled
    ? `${baseQuery} romanized`
    : baseQuery;

  const encoded = encodeURIComponent(finalQuery);

  const urls = {
    genius: `https://genius.com/search?q=${encoded}`,
    colorcoded: `https://colorcodedlyrics.com/?s=${encoded}`,
    az: `https://www.google.com/search?q=site:azlyrics.com+${encoded}`,
    musixmatch: `https://www.musixmatch.com/search?query=${encoded}`,
  };

  await openUrl(urls[site]);
  await win.hide();
};