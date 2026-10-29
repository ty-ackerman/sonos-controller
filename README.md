# Sonos Controller

A web app that controls Sonos speakers across multiple locations. Pick a playlist, adjust the volume, skip tracks — all from a single page in your browser.

## What it does

- **Playback controls** — play/pause, skip, previous, volume (per-speaker and group)
- **Favorites & playlists** — browse your Sonos favorites, start them with one tap
- **Multi-location support** — switch between locations (e.g. "College" and "Leslieville"), each with their own Sonos system. A **Test** location is listed only in manager view. It uses its own Sonos login (`global-automation-test`), opens the **Roam 2** system on that account, and is left out of the playback watchdog. Front desk sessions cannot stay on it.
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

## Stall recovery (Test location only, for now)

Sometimes Sonos hits several Spotify songs in a row that it can't play (for example songs that have been removed or are unavailable in your country). It skips a few, then gives up: the group drops to **idle at the very start of the queue** and stays silent until someone presses play. A normal pause looks different (it says **paused**, partway into a song), so the two are easy to tell apart.

Two things watch for exactly that pattern, using the same code (`stallRecovery.js`):

- **Fast path:** while the Test page is open, the app checks the speaker every few seconds. The moment it sees "idle at the start" it starts a background function (`playback-recovery-background.js`), so recovery begins within seconds.
- **Backstop:** a scheduled function (`playback-recovery.js`) checks once a minute even if nobody has the page open, so the worst case is about a minute.

A lock in the database makes sure only one recovery runs at a time. When a group was playing within the last couple of minutes and is now idle at the start, it:

1. Waits 5 seconds and checks again, so a slow start is not treated as a failure.
2. **Reloads the playlist that was playing** (the same Spotify playlist, back to the start).
3. Turns **shuffle on**, which makes a run of bad songs in a row much less likely. Other play modes are left as they were.
4. Presses **play**.
5. Puts **every speaker's volume** back to what it was while the music was still playing (it saves these every minute while playing, so it is not fooled by anything the reload changes).

Safety limits: it never touches a paused group, it recovers a group at most twice in 10 minutes (so a playlist full of bad songs can't loop forever), and every step is logged with `[TRACE-RECOVERY]`. If it can't match the loaded playlist to a saved favorite, it still turns on shuffle and presses play on the current queue. It remembers when each group last played, and the speaker volumes, in the Supabase table `playback_health` (see `supabase-schema.sql`). Shuffle stays on afterwards. College and Leslieville are not covered yet.

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
