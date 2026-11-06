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

> **Switched off for now.** The watchdog's location list is empty, because "Stall recovery" below now covers every location and the two would otherwise act on the same speaker. The description is kept for reference.

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

## Stall recovery (all locations)

Sometimes Sonos hits several Spotify songs in a row that it can't play (for example songs that have been removed or are unavailable in your country). It skips a few, then gives up: the group drops to **idle at the very start of the queue** and stays silent until someone presses play. A normal pause looks different (it says **paused**, partway into a song), so the two are easy to tell apart.

Three things watch for exactly that pattern, using the same code (`stallRecovery.js`):

- **Error cascade (events):** some failures never sit buffering for 2 seconds: Sonos reports several errors within a second and then gives up (this happened at 3:37am on 2026-10-29). When Sonos sends a `playbackError`, the app starts the background function, which reloads the playlist as soon as it sees **three or more errors within three seconds**, or Sonos going idle on two checks in a row. It only takes the recovery lock at the moment it is ready to recover, so it can never block the slow-buffer path below.
- **Slow buffering (events):** a healthy song takes about 1 second to start, while a failing one sits in "buffering" for about 20 seconds before Sonos reports an error. Sonos tells the app the instant a song starts buffering (see "Diagnosing playback problems" below), so the app starts the background function (`playback-recovery-background.js`), which checks the speaker again 2 seconds later (`BUFFER_LIMIT_MS` in `stallRecovery.js`). If that same song is still buffering, it runs the recovery straight away. If the reloaded playlist's first song also gets stuck, it tries again (up to 3 times, which is also the restart cap described below). A paused group is never touched. Trade-off: the occasional healthy song that takes more than 2 seconds will also trigger a reload. Look for "slow-buffer check" in the logs to see how often that happens.
- **Subscription renewal:** all of the above depend on Sonos sending events. Sonos subscriptions can in principle be lost (for example if a speaker restarts), and nothing would warn us. We have not seen this happen. As a cheap safeguard, the scheduled check re-subscribes every group every 10 minutes, which is harmless if the subscription is still alive (it was every minute at first, but that added too many Sonos calls). The log line `event subscription renewed` is the proof. **Regrouping is the real risk:** when staff pair, unpair or regroup speakers, Sonos throws away the old group's subscription and the group gets a new id. That happened at College at 3:48pm on 2026-10-29 and silenced our events for 12 minutes. So the app also subscribes to Sonos's "group changed" events for each location, and when one arrives (`groupCoordinatorChanged` or `groups` in the logs) it re-subscribes every group in that household straight away (look for `group change: re-subscribed` in the logs).
- **Too many requests (429):** Sonos limits how fast it can be asked things. When all three locations were switched on, the app's own checks (reading every speaker's volume every minute, re-subscribing every minute, looking up the speaker for every event) pushed it over that limit, and recoveries silently did nothing. The app now keeps those calls to a minimum (it remembers which location a speaker belongs to, no longer saves volumes every minute, renews subscriptions twice an hour), and if Sonos does answer 429 it waits a moment and tries once more. The slow-buffer check is also as cheap as possible: it waits 2 seconds, reads the speaker's state (one call), and only looks up the speaker's name and group when a song really is stuck. (An earlier version looked the group up before every check; during fast skipping that was dozens of calls a minute, Sonos answered 429 to all of them, and no recovery could run.) Look for `Sonos said 429` in the logs.
- **Status poll:** while a location's page is open and visible, the app checks the speaker every 10 seconds (it used to be every 3, and kept going on hidden tabs). If it sees "idle at the start" it starts the same background function. Each check costs about 3 Sonos calls, and Sonos allows only **20,000 calls per day per Sonos user** (600 a minute, resetting at 00:00 UTC), so polling was the main way a location could run out for the rest of the day. Skip and play/pause refresh the card straight away, so those still feel instant.
- **Backstop:** a scheduled function (`playback-recovery.js`) checks once a minute even if nobody has the page open, so the worst case is about a minute.

A lock in the database makes sure only one recovery runs at a time. When Sonos reports a failed song and the group then goes idle (or, for the two slower paths, when a group was playing within the last couple of minutes and is now idle at the start), it:

1. Confirms it is still idle (the slower paths wait 2 seconds; the events path has already checked twice), so a slow start is not treated as a failure.
2. **Reloads the playlist that was playing** (the same Spotify playlist, back to the start).
3. Turns **shuffle on**, which makes a run of bad songs in a row much less likely. Other play modes are left as they were.
4. Starts **play**. Steps 2 to 4 are a single request to Sonos; if Sonos refuses that, the app falls back to doing them one at a time, and if the music still hasn't started after 1.5 seconds it presses play itself.
5. Leaves **every speaker's volume** as it is. It reads the live volumes at the moment of the failure and, after the reload, only changes a speaker if the reload itself moved it, putting it back to that same live value. It never uses an older saved volume, because that could undo a change someone had just made.

Safeguards: it never touches a paused group, and every step is logged with `[TRACE-RECOVERY]`. There **is** a limit on restarts: after **3 restarts of the same group within 10 minutes** it stops, sends one urgent phone alert, and leaves the group alone for **30 minutes** (see "Restart cap" below). **It only acts on saved playlists** (Sonos favorites): if the loaded playlist doesn't match a saved favorite, as with a playlist staff bring to a class, it logs `not a saved playlist ... doing nothing` and touches nothing, so the class order is never scrambled. It remembers when each group last played in the Supabase table `playback_health` (see `supabase-schema.sql`). Shuffle stays on afterwards. Test, College and Leslieville are all covered (the list is `RECOVERY_DEVICE_IDS` in `stallRecovery.js`). Classes are not covered yet: that is a separate problem (keeping the song order and resuming from the song that failed).

### Restart cap (why it stops trying)

Restarting a playlist fixes songs that Sonos can't play. It can't fix a speaker that *accepts* "load this playlist" but never actually starts. A likely cause is the speaker's Spotify link inside Sonos going stale: playing from the Spotify app still works (Spotify does the playing itself), but every saved playlist fails. On 2026-11-06 College hit exactly this and the app restarted the playlist about once a minute for 10 minutes straight, and had done the same the day before. Each restart costs several Sonos calls, and Sonos allows only 20,000 a day, so a loop like that can use up the day's allowance.

So now, in `stallRecovery.js`:

- Every restart is counted in `playback_health.recoveries` for 10 minutes. This applies to all three triggers (events, slow buffering, the one-minute check).
- After **3** restarts in that window the app **gives up**: it logs `GIVING UP`, sends the urgent alert below, writes `playback_health.gave_up_at`, and does **no more restarts for 30 minutes** (it logs `not restarting: gave up on it less than 30 minutes ago`). After the 30 minutes it may try again, but then it is 3 restarts and one alert, not a loop.
- The count and the cooldown are cleared as soon as the group has **played for a full minute** (checked by the one-minute check), so a group that really recovered is never held back.

**If you get the "will not start" alert:** play one of the saved playlists from the **Sonos app** itself. If it fails there too, the problem is Sonos's link to Spotify, not this app. In the Sonos app go to Settings, then Services and Voice, then Spotify, remove it and add it again. Playing from the Spotify app will keep working meanwhile.

### Phone alerts (ntfy)

The app can message your phone when a speaker fails, using the free service [ntfy](https://ntfy.sh). How to turn it on:

1. Install the **ntfy** app (iPhone or Android) and subscribe to your private topic name.
2. In Netlify, go to Site configuration, then Environment variables, and add `NTFY_TOPIC` with that same topic name. Then redeploy. Without this variable, nothing is sent and nothing else changes.

You get these messages:

- **"Sonos failed at ..."** when a saved playlist stalls and the app starts restarting it.
- **"Sonos recovered at ..."** once music is playing again, with the seconds it took.
- **"Sonos still not playing at ..."** (urgent) if the reload didn't get music going (and the restart cap hasn't been reached yet).
- **"Sonos playlists will not start at ..."** (urgent) when the restart cap is reached: 3 restarts in 10 minutes and still nothing. It says what to check, and quotes the error Sonos reported, if there was one. Sent once, then the app waits 30 minutes.
- **"Sonos failed at ... (not fixed)"** (urgent) when the stalled playlist is not a saved one, such as a class playlist. The app deliberately does nothing there, so someone has to press play.

Anyone who knows the topic name can read the messages, so treat it like a password and don't use an easy-to-guess name. The messages contain only the location, speaker group and playlist names.

## Diagnosing playback problems (logs)

When a track fails to load, Sonos reports why in a `playbackError` event. The app can receive these, but only after one manual step in the Sonos developer portal.

- **One-time setup:** in the Sonos integration page for this API key, set the **callback URL** to `https://sonos-controller.netlify.app/sonos/events`. Until that is set, Sonos rejects event subscriptions with `callbackUrl cannot be null or empty`.
- **What the app does:** it subscribes to every location's playback events (when a location's page is open, and every 10 minutes from the scheduled check, plus straight away when Sonos reports a group change) and logs each one. The recovery described above acts on two kinds of event: a song starting to buffer, and a playback error.
- **Where to look:** in the Netlify function logs for `server`, search for these prefixes:
  - `[TRACE]` — one line per status poll (state, song, next song, item, any Sonos error)
  - `[TRACE-CMD]` — each skip and play/pause the app sends, plus Sonos's reply. `play favorite accepted by Sonos` means Sonos took the command, **not** that music started.
  - `[TRACE-SONOS]` — any command Sonos *refused* (the full error text it answered, for example `ERROR_...` and the reason), and any read that failed with a server error or rate limit (429)
  - `[TRACE-RECOVERY]` — every recovery step. `NOT PLAYING after reload` says what the speaker thinks it has loaded and the last Sonos error; `GIVING UP` is the restart cap kicking in
  - `[TRACE-EVT]` — events sent by Sonos; `!!ERROR!!` marks a `playbackError`
  - `[TRACE-WD]` — what the watchdog saw
- **The last error Sonos reported is also saved** in the database: `playback_health.last_error` has the `code`, `reason` and time of the most recent `playbackError` for each group, so you can read it even after the logs have scrolled away.
- **Logs never contain Sonos login tokens** (not even a partial one). Copied log files used to, which is why `logs.txt` and `*.log` are in `.gitignore`. If you paste logs anywhere, they are safe to share as far as tokens go, but still don't post them publicly.

### Database safety (Row Level Security)

The Sonos logins live in the Supabase table `tokens`. Row Level Security is switched **on** for it, so the public key (the one that could end up in a web page) can read nothing from it. The app is unaffected because the server uses the service key, which skips these rules. Do not replace `SUPABASE_KEY` with the public key. `supabase-schema.sql` has the exact statements. (Other tables, such as `speaker_volumes` and `playlist_vibes`, don't hold secrets and still have RLS off; Supabase flags that, and the same one-line change would fix it.)

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
└── scripts/refresh-auth.js           # Browser login helper. SWITCHED OFF: no longer runs nightly (see below)
```

### Nightly login refresh (switched off)

There used to be a GitHub Actions job (`.github/workflows/refresh-auth.yml`) that logged in to Sonos in a headless browser every night to refresh the College and Leslieville logins. It is **off**, deliberately:

- It had been failing every night since April 2026, and GitHub then disabled it for inactivity (after July 6). Nobody was told either time.
- It isn't needed: the app refreshes each location's Sonos login itself whenever it is used, and the one-minute recovery check keeps using it, so every location's login stays fresh (check `updated_at` in the `tokens` table; it should be within the last day).
- The workflow file keeps only a manual "run" button (no schedule). If a location ever shows "Not authenticated with Sonos", log in again from that location's page; the helper can be run by hand from GitHub's Actions tab.
- The four GitHub secrets it used (`SONOS_EMAIL_*` and `SONOS_PASSWORD_*`, the Sonos account passwords) are still stored in the repository settings. Delete them under Settings, then Secrets and variables, then Actions, if you don't plan to use the helper.

## Setup

See [DEPLOYMENT.md](DEPLOYMENT.md) for Netlify deployment and [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) for running locally.
