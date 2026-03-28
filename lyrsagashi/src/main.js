import "./styles.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID;

const win = getCurrentWindow();

function log(msg) {
  console.log(msg);
  try {
    invoke("log_message", { message: msg });
  } catch {}
}

async function getRedirectUri() {
  const port = await invoke("get_oauth_port").catch(() => 4381);
  return `http://127.0.0.1:${port}/callback`;
}

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

function setAuthStatus(message, isError = true) {
  const el = document.getElementById("authStatus");
  if (!el) return;
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.style.color = isError ? "#CC3A3A" : "rgba(30,20,10,0.55)";
  el.classList.remove("hidden");
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

async function buildAuthUrl() {
  let verifier = localStorage.getItem("spotify_code_verifier");
  if (!verifier) {
    verifier = generateRandomString(64);
    localStorage.setItem("spotify_code_verifier", verifier);
  }
  const challenge = base64urlencode(await sha256(verifier));
  const uri = await getRedirectUri();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "user-read-currently-playing user-read-playback-state",
    redirect_uri: uri,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function loginSpotify() {
  const url = await buildAuthUrl();
  await openUrl(url);
}

let lastCode = null;
let isExchanging = false;

async function exchangeToken(code) {
  const normalizedCode = String(code ?? "").trim();
  if (!normalizedCode) {
    setAuthStatus("Missing auth code from callback. Please try sign-in again.");
    log("Exchange aborted: missing auth code");
    await showLoginScreen();
    return;
  }

  if (normalizedCode === lastCode) {
    log("Skipping duplicate code exchange");
    return;
  }
  
  if (isExchanging) {
    log("Already exchanging a token, ignoring concurrent request.");
    return;
  }
  
  isExchanging = true;
  lastCode = normalizedCode;

  const verifier = localStorage.getItem("spotify_code_verifier");
  if (!verifier) {
    console.error("Missing PKCE verifier; restarting login flow.");
    log("Exchange aborted: missing PKCE verifier");
    setAuthStatus("Login session expired. Please sign in again.");
    await showLoginScreen();
    return;
  }

  setAuthStatus("Finishing Spotify login...", false);

  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code: normalizedCode,
        redirect_uri: await getRedirectUri(),
        code_verifier: verifier,
      }),
    });

    const data = await res.json();
    if (data.access_token) {
      localStorage.setItem("spotify_token", data.access_token);
      if (data.refresh_token) localStorage.setItem("spotify_refresh_token", data.refresh_token);
      localStorage.removeItem("spotify_code_verifier");
      try { await invoke("clear_oauth_code"); } catch {}
      setAuthStatus("");
      showMain();
      await fetchTrack();
      isExchanging = false;
      return;
    }

    console.error("Token exchange failed:", data);
    localStorage.removeItem("spotify_code_verifier");
    const reason = data?.error_description || data?.error || "Unknown OAuth error";
    setAuthStatus(`Spotify login failed: ${reason}`);
    await showLoginScreen();
  } catch (err) {
    console.error("Token exchange request failed:", err);
    localStorage.removeItem("spotify_code_verifier");
    setAuthStatus("Couldn't reach Spotify token server. Please check connection and try again.");
    await showLoginScreen();
  } finally {
    isExchanging = false;
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
    if (!res.ok) { 
      let errMsg = "";
      try {
        const errData = await res.json();
        errMsg = errData.error?.message || "";
      } catch {}
      log(`Spotify API error. Code: ${res.status} ${errMsg}`);
      updateDisplay("Playback unavailable", `API Error ${res.status}: ${errMsg || "Unknown"}`);
      buttons.forEach(b => (b.disabled = true));
      return; 
    }

    const data = await res.json();
    if (!data.item) {
      updateDisplay("Nothing playing", "Open Spotify and play something");
      buttons.forEach(b => (b.disabled = true));
      return;
    }

    currentSong   = data.item.name;
    currentArtist = data.item.artists ? data.item.artists.map(a => a.name).join(", ") : "Unknown Artist";
    updateDisplay(currentSong, currentArtist);
    buttons.forEach(b => (b.disabled = false));

  } catch (err) {
    console.error("Spotify fetch failed:", err);
  }
}

async function showLoginScreen() {
  showLogin();
  setAuthStatus("");

  const url = await buildAuthUrl();

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

  const btn = document.getElementById("spotifySignInBtn");
  if (btn) {
    btn.onclick = () => openUrl(url);
  }
}

// Init — keep sync work minimal so the window can paint; defer IPC / auth setup.
window.addEventListener("DOMContentLoaded", () => {
  log("[INIT] App started");

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

  void (async () => {
    await listen("spotify-code", async (e) => {
      const rawCode = String(e.payload ?? "");
      const code = (() => {
        try {
          return decodeURIComponent(rawCode).trim();
        } catch {
          return rawCode.trim();
        }
      })();
      log("[EVENT] spotify-code received (hidden from logs)");
      try { await invoke("ack_oauth_received"); } catch {}
      await exchangeToken(code);
    });

    window.fetchTrack = fetchTrack;
    window.showLoginScreen = showLoginScreen;
    window.signOut = () => {
      localStorage.removeItem("spotify_token");
      localStorage.removeItem("spotify_refresh_token");
      buttons.forEach(b => (b.disabled = true));
      showLoginScreen();
    };

    const pendingCode = await invoke("read_oauth_code").catch(() => null);

    if (pendingCode) {
      log("Recovered OAuth code from file on startup");
      await exchangeToken(pendingCode);
    } else if (localStorage.getItem("spotify_token")) {
      showMain();
      void fetchTrack();
    } else {
      showLogin();
      setAuthStatus("");
      const url = await buildAuthUrl();
      const btn = document.getElementById("spotifySignInBtn");
      if (btn) btn.onclick = () => openUrl(url);
      const copyBtn = document.getElementById("authLinkBtn");
      const copyText = document.getElementById("authLinkText");
      if (copyBtn && copyText) {
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(url);
            copyText.textContent = "Copied!";
            setTimeout(() => { copyText.textContent = "Copy login link"; }, 2000);
          } catch (e) { console.error("Failed to copy", e); }
        };
      }
    }

    setInterval(async () => {
      if (!navigator.onLine) return;
      if (!localStorage.getItem("spotify_token")) return;
      try {
        await fetchTrack();
      } catch (e) {
        log("Retry fetch failed: " + e.message);
      }
    }, 5000);
  })();
});

// Open lyrics
window.openLyrics = async function(site) {
  if (!currentSong) return;

  const baseQuery = `${currentSong} ${currentArtist}`;
  const finalQuery = romanizedEnabled ? `${baseQuery} romanized` : baseQuery;
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