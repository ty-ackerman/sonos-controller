# Sonos Controller

A web app that controls Sonos speakers across multiple locations. Pick a playlist, adjust the volume, skip tracks — all from a single page in your browser.

## What it does

- **Playback controls** — play/pause, skip, previous, volume (per-speaker and group)
- **Favorites & playlists** — browse your Sonos favorites, start them with one tap
- **Multi-location support** — switch between locations (e.g. "College" and "Leslieville"), each with their own Sonos system
- **Vibe-based scheduling** — tag playlists with "vibes" and set time-of-day rules so the right music plays automatically
- **Playback watchdog** — a background function that checks every minute whether music unexpectedly stopped and auto-resumes it

## How it's built

| Layer | Tech |
|-------|------|
| Frontend | Single-page app (`public/index.html`) |
| Backend | Express, wrapped as a Netlify Function |
| Auth | Sonos OAuth2, tokens stored in Supabase |
| Scheduled | Netlify Scheduled Function for playback monitoring |
| Hosting | Netlify (static + serverless) |

## Playback Watchdog

Sonos occasionally fails to load the next track in a playlist (streaming hiccup, network blip, etc.), leaving the speaker silent. The watchdog catches this automatically.

**How it works:**

1. Runs every 1 minute as a Netlify Scheduled Function (`netlify/functions/playback-watchdog.js`)
2. For each location, fetches the current playback state directly from the Sonos API
3. If a group's state is **IDLE** (not user-paused) but still has a playlist/container loaded, it sends a `play` command to resume
4. If the state is **PAUSED** (user intentionally paused), it leaves it alone

**What it won't do:**
- Resume music you deliberately paused
- Start music from scratch if nothing was playing
- Interfere with active playback

**Worst case:** up to ~60 seconds of silence before the watchdog kicks in and resumes. The check runs every minute.

## Project structure

```
├── server.js                         # Express API (Sonos proxy, auth, recommendations)
├── public/index.html                 # The entire frontend SPA
├── netlify/functions/
│   ├── server.js                     # Wraps Express for Netlify Functions
│   └── playback-watchdog.js          # Scheduled: auto-resumes stalled playback
├── tokenStore.js                     # Sonos OAuth token storage (Supabase)
├── settingsStore.js                  # Speaker volume defaults
├── playlistVibesStore.js             # Playlist "vibe" tags
├── vibeTimeRulesStore.js             # Time-based playlist rules
├── hiddenFavoritesStore.js           # Hidden favorites management
├── supabase.js                       # Supabase client
├── netlify.toml                      # Netlify routing & build config
└── scripts/refresh-auth.js           # Daily OAuth token refresh (GitHub Actions)
```

## Setup

See [DEPLOYMENT.md](DEPLOYMENT.md) for Netlify deployment and [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) for running locally.
