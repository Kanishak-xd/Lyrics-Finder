import "./styles.css";
import { open } from "@tauri-apps/plugin-shell";

let currentSong = "";
let currentArtist = "";
let buttons;

function buildQuery() {
  return encodeURIComponent(`${currentSong} ${currentArtist}`);
}

async function fetchTrack() {
  try {
    const token = localStorage.getItem("spotify_token");

    const res = await fetch(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (res.status === 204) {
      document.getElementById("song").textContent = "Nothing playing";
      document.getElementById("artist").textContent = "Start Spotify music";
      return;
    }

    if (!res.ok) return;

    const data = await res.json();

    currentSong = data.item.name;
    currentArtist = data.item.artists.map(a => a.name).join(", ");

    document.getElementById("song").textContent = currentSong;
    document.getElementById("artist").textContent = currentArtist;

    buttons.forEach(b => b.disabled = false);

  } catch (err) {
    console.error("Spotify fetch failed", err);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  buttons = document.querySelectorAll("button");
  buttons.forEach(b => b.disabled = true);

  fetchTrack();
});

window.openLyrics = function(site) {

  if (!currentSong) return;

  const q = buildQuery();

  const urls = {
    genius: `https://genius.com/search?q=${q}`,
    colorcoded: `https://colorcodedlyrics.com/?s=${q}`,
    az: `https://search.azlyrics.com/search.php?q=${q}`,
    musixmatch: `https://www.musixmatch.com/search/${q}`
  };

  open(urls[site]);
};