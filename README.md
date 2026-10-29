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

Three things watch for exactly that pattern, using the same code (`stallRecovery.js`):

- **Fastest path (events):** Sonos tells the app the instant a song fails (a `playbackError` event, see "Diagnosing playback problems" below). The app starts the background function (`playback-recovery-background.js`) straight away, which checks the speaker every half second. As soon as Sonos gives up (idle on two checks in a row) it reloads the playlist, with no fixed waiting. If Sonos reports **three or more errors within three seconds** (a cascade, which in every failure so far ended with Sonos giving up), it doesn't even wait for that: it reloads right away. If Sonos recovers on its own, or the group is paused, it does nothing.
- **Slow buffering (catches it before Sonos fails):** a healthy song takes about 1 second to start, while a failing one sits in "buffering" for about 20 seconds before Sonos reports an error. Sonos also tells the app the instant a song starts buffering, so the app checks again 2 seconds later (`BUFFER_LIMIT_MS` in `stallRecovery.js`). If that same song is still buffering, it runs the recovery straight away. Trade-off: the occasional healthy song that takes more than 2 seconds will also trigger a reload. Look for "slow-buffer check" in the logs to see how often that happens.
- **Subscription renewal:** all of the above depend on Sonos sending events. Sonos can quietly drop that subscription (it happened once, and the speaker kept playing while the app heard nothing). So the one-minute scheduled check also re-subscribes every group each minute, which is harmless if the subscription is still alive. The log line `event subscription renewed` appears about every 10 minutes as proof.
- **Status poll:** while the Test page is open, the app checks the speaker every few seconds. If it sees "idle at the start" it starts the same background function.
- **Backstop:** a scheduled function (`playback-recovery.js`) checks once a minute even if nobody has the page open, so the worst case is about a minute.

A lock in the database makes sure only one recovery runs at a time. When Sonos reports a failed song and the group then goes idle (or, for the two slower paths, when a group was playing within the last couple of minutes and is now idle at the start), it:

1. Confirms it is still idle (the slower paths wait 2 seconds; the events path has already checked twice), so a slow start is not treated as a failure.
2. **Reloads the playlist that was playing** (the same Spotify playlist, back to the start).
3. Turns **shuffle on**, which makes a run of bad songs in a row much less likely. Other play modes are left as they were.
4. Starts **play**. Steps 2 to 4 are a single request to Sonos; if Sonos refuses that, the app falls back to doing them one at a time, and if the music still hasn't started after 1.5 seconds it presses play itself.
5. Puts **every speaker's volume** back to what it was while the music was still playing (it saves these every minute while playing, so it is not fooled by anything the reload changes).

Safeguards: it never touches a paused group, and every step is logged with `[TRACE-RECOVERY]`. There is **no limit on how many times** it recovers a group, by choice: a playlist made entirely of unplayable songs would keep restarting until someone stops it. If it can't match the loaded playlist to a saved favorite, it still turns on shuffle and presses play on the current queue. It remembers when each group last played, and the speaker volumes, in the Supabase table `playback_health` (see `supabase-schema.sql`). Shuffle stays on afterwards. College and Leslieville are not covered yet.

## Diagnosing playback problems (logs)

When a track fails to load, Sonos reports why in a `playbackError` event. The app can receive these, but only after one manual step in the Sonos developer portal.

- **One-time setup:** in the Sonos integration page for this API key, set the **callback URL** to `https://sonos-controller.netlify.app/sonos/events`. Until that is set, Sonos rejects event subscriptions with `callbackUrl cannot be null or empty`.
- **What the app does:** while the Test location is open, it subscribes to the Roam's playback events and logs each one. It does not skip, pause, or resume anything because of them.
- **Where to look:** in the Netlify function logs for `server`, search for these prefixes:
  - `[TRACE]` — one line per status poll (state, song, next song, item, any Sonos error)
  - `[TRACE-CMD]` — each skip and play/pause the app sends, plus Sonos's reply
  - `[TRACE-EVT]` — events sent by Sonos; `!!ERROR!!` marks a `playbackError`
  - `[TRACE-WD]` — what the watchdog saw

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
