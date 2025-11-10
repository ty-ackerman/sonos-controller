import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTokens, saveTokens, clearTokens } from './tokenStore.js';
import { loadSpeakerVolumes, saveSpeakerVolumes } from './settingsStore.js';
import { loadPlaylistVibes, savePlaylistVibes } from './playlistVibesStore.js';

// Use native fetch (Node.js 18+) - Netlify Functions supports it
// No need to import node-fetch which causes bundling issues

dotenv.config();

const {
  SONOS_CLIENT_ID,
  SONOS_CLIENT_SECRET,
  REDIRECT_URI,
  PORT = 3000
} = process.env;

if (!SONOS_CLIENT_ID || !SONOS_CLIENT_SECRET || !REDIRECT_URI) {
  console.error('Missing Sonos configuration in environment variables.');
  process.exit(1);
}

const SONOS_AUTH_BASE = 'https://api.sonos.com';
const SONOS_CONTROL_BASE = 'https://api.ws.sonos.com/control/api/v1';
const SCOPES = 'playback-control-all';

// Get directory path for static files (only needed for local development)
// In Netlify Functions, static files are served directly by Netlify, not Express
// Avoid declaring __filename/__dirname to prevent conflicts with bundler-provided globals
function getDirname() {
  try {
    // Try to use import.meta.url to get the directory
    const currentFileUrl = import.meta.url;
    const currentFilePath = fileURLToPath(currentFileUrl);
    return path.dirname(currentFilePath);
  } catch (error) {
    // Fallback: use process.cwd()
    return process.cwd();
  }
}

const app = express();
app.use(express.json());

// Initialize data storage (lazy-loaded for serverless compatibility)
let tokens = null;
let speakerVolumes = null;
let playlistVibes = null;
let initialized = false;
let initializationPromise = null;

const activeFavoritesByGroup = new Map();

let oauthState;

// Initialize data stores (lazy loading for serverless)
async function ensureInitialized() {
  if (initialized) {
    return;
  }
  
  if (initializationPromise) {
    return initializationPromise;
  }
  
  initializationPromise = (async () => {
    try {
      if (!tokens) {
        tokens = await loadTokens();
        // Ensure tokens object exists
        if (!tokens) {
          tokens = { access_token: null, refresh_token: null, expires_at: 0 };
        }
      }
      if (!speakerVolumes) {
        speakerVolumes = await loadSpeakerVolumes();
        // Ensure speakerVolumes object exists
        if (!speakerVolumes) {
          speakerVolumes = {};
        }
      }
      if (!playlistVibes) {
        playlistVibes = await loadPlaylistVibes();
        // Ensure playlistVibes object exists
        if (!playlistVibes) {
          playlistVibes = {};
        }
      }
      initialized = true;
    } catch (error) {
      console.error('Error initializing data stores:', error);
      // Set defaults on error
      tokens = tokens || { access_token: null, refresh_token: null, expires_at: 0 };
      speakerVolumes = speakerVolumes || {};
      playlistVibes = playlistVibes || {};
      initialized = true;
      throw error;
    }
  })();
  
  return initializationPromise;
}

// Middleware to ensure initialization before handling API/auth requests
// Note: Static files are served by Netlify, so we only initialize for dynamic routes
app.use(/^\/(api|auth|healthz)/, async (req, res, next) => {
  await ensureInitialized();
  next();
});

// Serve static files (only needed for local development, Netlify serves these directly)
app.use(express.static(path.join(getDirname(), 'public')));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/auth/sonos/login', (_req, res) => {
  oauthState = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: SONOS_CLIENT_ID,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state: oauthState
  });

  res.redirect(`${SONOS_AUTH_BASE}/login/v3/oauth?${params.toString()}`);
});

app.get('/auth/sonos/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Sonos OAuth error:', error);
    return res.redirect('/?auth=error');
  }

  if (!code) {
    return res.redirect('/?auth=missing_code');
  }

  if (!state || state !== oauthState) {
    return res.redirect('/?auth=invalid_state');
  }

  try {
    await exchangeCodeForTokens(code);
    oauthState = undefined;
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('Failed to exchange code for tokens', err);
    res.redirect('/?auth=error');
  }
});

app.get('/auth/status', async (_req, res) => {
  try {
    let loggedIn = Boolean(tokens.access_token) && Date.now() < (tokens.expires_at || 0);

    if (loggedIn) {
      try {
        await sonosRequest('/households');
      } catch (error) {
        if (error.status === 401) {
          tokens = await clearTokens();
          loggedIn = false;
        } else {
          console.warn('Failed to verify token during status check:', error?.message ?? error);
        }
      }
    }

    res.json({ loggedIn, expiresAt: loggedIn ? tokens.expires_at || 0 : 0 });
  } catch (error) {
    console.error('Auth status check failed:', error?.message ?? error);
    res.json({ loggedIn: false });
  }
});

app.post('/auth/signout', async (_req, res) => {
  tokens = await clearTokens();
  res.json({ ok: true });
});

app.get('/api/households', async (_req, res) => {
  try {
    const response = await sonosRequest('/households');
    const payload = await response.json();
    res.json(payload);
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/households/:householdId/groups', async (req, res) => {
  const { householdId } = req.params;

  try {
    const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/groups`);
    const payload = await response.json();
    res.json(payload);
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/playpause', async (req, res) => {
  const { groupId } = req.params;

  try {
    await sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/togglePlayPause`, {
      method: 'POST'
    });
    res.json({ status: 'ok' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/volume', async (req, res) => {
  const { groupId } = req.params;
  const { volume } = req.body ?? {};
  const level = Number(volume);

  if (!Number.isFinite(level) || level < 0 || level > 100) {
    return res.status(400).json({ error: 'Volume must be a number between 0 and 100.' });
  }

  try {
    await sonosRequest(`/groups/${encodeURIComponent(groupId)}/groupVolume`, {
      method: 'POST',
      body: JSON.stringify({ volume: level })
    });
    res.json({ status: 'ok', volume: level });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/next', async (req, res) => {
  const { groupId } = req.params;

  try {
    await sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/skipToNextTrack`, {
      method: 'POST'
    });
    res.json({ status: 'ok' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/previous', async (req, res) => {
  const { groupId } = req.params;

  try {
    await sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/skipToPreviousTrack`, {
      method: 'POST'
    });
    res.json({ status: 'ok' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/groups/:groupId/playback/status', async (req, res) => {
  const { groupId } = req.params;

  try {
    // Try playbackStatus endpoint first (more reliable), fallback to playbackState
    const [statusResponse, metadataResponse] = await Promise.allSettled([
      sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/playbackStatus`).catch(() => {
        // Fallback to playbackState if playbackStatus fails
        return sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/playbackState`).catch((err) => {
          console.error('[PlaybackStatus] Both playbackStatus and playbackState requests failed:', err.message);
          return null;
        });
      }),
      sonosRequest(`/groups/${encodeURIComponent(groupId)}/playbackMetadata`).catch((err) => {
        console.error('[PlaybackStatus] playbackMetadata request failed:', err.message);
        return null;
      })
    ]);

    const playbackState = statusResponse.status === 'fulfilled' && statusResponse.value
      ? await statusResponse.value.json().catch((err) => {
          console.error('[PlaybackStatus] Failed to parse playbackState JSON:', err.message);
          return {};
        })
      : {};

    const metadata = metadataResponse.status === 'fulfilled' && metadataResponse.value
      ? await metadataResponse.value.json().catch((err) => {
          console.error('[PlaybackStatus] Failed to parse metadata JSON:', err.message);
          return {};
        })
      : {};

    const volumeResponse = await sonosRequest(`/groups/${encodeURIComponent(groupId)}/groupVolume`).catch(() => null);
    const volume = volumeResponse ? await volumeResponse.json().catch(() => ({})) : {};

    // DEBUG: Log what we're getting from Sonos API - FULL raw response
    console.log('[PlaybackStatus] Raw responses:', {
      statusResponseStatus: statusResponse.status,
      playbackStateKeys: Object.keys(playbackState),
      playbackStateValue: JSON.stringify(playbackState, null, 2),
      metadataKeys: Object.keys(metadata),
      hasCurrentItem: !!(metadata.currentItem || metadata.item),
      fullPlaybackStateResponse: statusResponse.status === 'fulfilled' && statusResponse.value 
        ? await statusResponse.value.text().catch(() => 'Failed to get text')
        : 'No response'
    });

    const currentItem = metadata.currentItem || metadata.item || null;
    let track = null;
    
    if (currentItem) {
      track = currentItem.track || currentItem.container?.metadata || currentItem;
      
      if (track && typeof track === 'object') {
        const normalizeField = (field) => {
          if (!field) return null;
          if (typeof field === 'string') return field;
          if (typeof field === 'object') {
            return field.name || field.value || field.text || null;
          }
          return String(field);
        };

        track = {
          name: normalizeField(track.name) || normalizeField(track.title),
          artist: normalizeField(track.artist) || normalizeField(track.albumArtist) || normalizeField(track.creator),
          album: normalizeField(track.album) || normalizeField(track.albumName),
          imageUrl: normalizeField(track.imageUrl) || normalizeField(track.albumArtUri) || normalizeField(track.albumArtURL),
          ...track
        };
      }
    }

    const activeInfo = activeFavoritesByGroup.get(groupId);
    const activeFavoriteId = activeInfo ? activeInfo.favoriteId : null;

    // Try multiple possible field names for playback state
    // Sonos API uses: PLAYBACK_STATE_PLAYING, PLAYBACK_STATE_PAUSED, PLAYBACK_STATE_IDLE, PLAYBACK_STATE_STOPPED
    // Also check for simplified versions: PLAYING, PAUSED, IDLE, STOPPED
    let finalPlaybackState = playbackState.playbackState 
      || playbackState.state 
      || playbackState.playback?.state
      || playbackState.playbackState
      || metadata.playbackState
      || metadata.state
      || 'STOPPED';

    // Normalize state values (handle both PLAYBACK_STATE_PLAYING and PLAYING)
    if (finalPlaybackState.includes('PLAYING')) {
      finalPlaybackState = 'PLAYING';
    } else if (finalPlaybackState.includes('PAUSED')) {
      finalPlaybackState = 'PAUSED';
    } else if (finalPlaybackState.includes('IDLE')) {
      // IDLE typically means paused for streaming content
      finalPlaybackState = 'PAUSED';
    } else if (finalPlaybackState.includes('STOPPED') || finalPlaybackState === 'STOPPED') {
      finalPlaybackState = 'STOPPED';
    }

    // Fallback: If we have a currentItem but playbackState says STOPPED, 
    // assume it's playing (the API sometimes returns incorrect state)
    if (finalPlaybackState === 'STOPPED' && currentItem) {
      console.log('[PlaybackStatus] Inferring PLAYING from currentItem presence');
      finalPlaybackState = 'PLAYING';
    }

    console.log('[PlaybackStatus] Final playback state:', {
      finalPlaybackState,
      hasCurrentItem: !!currentItem,
      allPlaybackStateFields: {
        'playbackState.playbackState': playbackState.playbackState,
        'playbackState.state': playbackState.state,
        'playbackState.playback?.state': playbackState.playback?.state,
        'metadata.playbackState': metadata.playbackState,
        'metadata.state': metadata.state
      }
    });

    res.json({
      playbackState: finalPlaybackState,
      currentItem: currentItem ? { ...currentItem, track } : null,
      item: currentItem ? { ...currentItem, track } : null,
      track: track,
      volume: volume.volume || volume.groupVolume || 0,
      activeFavoriteId: activeFavoriteId,
      ...playbackState,
      ...metadata
    });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/players/:playerId/volume', async (req, res) => {
  const { playerId } = req.params;

  try {
    const response = await sonosRequest(
      `/players/${encodeURIComponent(playerId)}/playerVolume`
    );
    const body = await response.text();
    res.status(response.status).send(body);
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/image-proxy', async (req, res) => {
  const { url } = req.query;

  console.log('[ImageProxy] Request received:', { url, query: req.query });

  if (!url || typeof url !== 'string') {
    console.error('[ImageProxy] Missing or invalid URL parameter');
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const imageUrl = decodeURIComponent(url);
    console.log('[ImageProxy] Decoded URL:', imageUrl);
    
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      console.error('[ImageProxy] Invalid URL format (not http/https):', imageUrl);
      return res.status(400).json({ error: 'Invalid URL' });
    }

    console.log('[ImageProxy] Fetching image from:', imageUrl);
    const imageResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Sonos-Controller/1.0',
        'Accept': 'image/*'
      }
    });

    console.log('[ImageProxy] Response status:', imageResponse.status, imageResponse.statusText);

    if (!imageResponse.ok) {
      console.error(`[ImageProxy] Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText} for ${imageUrl}`);
      return res.status(imageResponse.status).json({ error: 'Failed to fetch image' });
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    console.log('[ImageProxy] Content-Type:', contentType);
    
    // Validate it's actually an image
    if (!contentType.startsWith('image/')) {
      console.error(`[ImageProxy] Non-image content type: ${contentType} for ${imageUrl}`);
      return res.status(400).json({ error: 'URL does not point to an image' });
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    console.log('[ImageProxy] Image buffer size:', imageBuffer.byteLength, 'bytes');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(imageBuffer));
    console.log('[ImageProxy] Image sent successfully');
  } catch (error) {
    console.error('[ImageProxy] Error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to proxy image', details: error.message });
  }
});

app.get('/api/favorites', async (req, res) => {
  try {
    const preferredHousehold =
      typeof req.query.householdId === 'string' && req.query.householdId.trim().length > 0
        ? req.query.householdId.trim()
        : undefined;
    const householdId = await resolveHouseholdId(preferredHousehold);
    const groupId =
      typeof req.query.groupId === 'string' && req.query.groupId.trim().length > 0
        ? req.query.groupId.trim()
        : undefined;

    const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/favorites`);
    const payload = await response.json();

    const activeInfo = groupId ? activeFavoritesByGroup.get(groupId) : undefined;
    const activeFavoriteId = activeInfo ? activeInfo.favoriteId : null;
    const activeFavorites = {};
    activeFavoritesByGroup.forEach((value, key) => {
      activeFavorites[key] = value.favoriteId;
    });

    res.json({ ...payload, householdId, activeFavorite: activeFavoriteId, activeFavorites });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/settings/volumes', async (_req, res) => {
  try {
    // Reload from database to ensure fresh data across devices
    const volumes = await loadSpeakerVolumes();
    // Update cache to keep it in sync
    speakerVolumes = volumes;
    res.json(volumes);
  } catch (error) {
    console.error('Error loading speaker volumes:', error);
    // Fallback to cached value if database load fails
    res.json(speakerVolumes || {});
  }
});

app.put('/api/settings/volumes', async (req, res) => {
  try {
    const incoming = req.body ?? {};
    // Pass the raw incoming data to handle null/empty values for deletion
    // saveSpeakerVolumes will handle sanitization and deletion
    const saved = await saveSpeakerVolumes(incoming);
    
    // Reload from database to get the complete current state (including deletions)
    const volumes = await loadSpeakerVolumes();
    // Update cache to keep it in sync
    speakerVolumes = volumes;
    res.json(volumes);
  } catch (error) {
    res
      .status(400)
      .json({ error: 'settings_save_failed', detail: error?.message ?? String(error) });
  }
});

app.get('/api/playlist-vibes', (_req, res) => {
  res.json(playlistVibes);
});

app.put('/api/playlist-vibes', async (req, res) => {
  try {
    const incoming = req.body ?? {};
    playlistVibes = await savePlaylistVibes(incoming);
    res.json(playlistVibes);
  } catch (error) {
    res
      .status(400)
      .json({ error: 'playlist_vibes_save_failed', detail: error?.message ?? String(error) });
  }
});

app.post('/api/groups/:groupId/favorites/play', async (req, res) => {
  const { groupId } = req.params;
  const {
    favoriteId,
    shuffle = true,
    repeat = true,
    crossfade = true,
    householdId: householdHint
  } = req.body ?? {};

  if (!favoriteId) {
    return res.status(400).json({ error: 'favoriteId is required.' });
  }

  const encodedGroupId = encodeURIComponent(groupId);

  try {
    const autogroupResult = await autogroupGroupMembers(groupId, householdHint);
    if (!autogroupResult.success) {
      console.warn(
        `Autogroup skipped for ${groupId}:`,
        autogroupResult.error ?? 'no household match'
      );
    }

    const householdForVolumes =
      autogroupResult.householdId ??
      (typeof householdHint === 'string' && householdHint.trim().length > 0
        ? householdHint.trim()
        : null);
    if (householdForVolumes) {
      await applyDefaultVolumes(householdForVolumes);
    }

    const clearResult = await clearGroupQueue(groupId);
    if (!clearResult.success && clearResult.supported) {
      console.warn(
        `Unable to fully clear queue for group ${groupId}:`,
        clearResult.error ?? 'unknown error'
      );
    }

    try {
      await sonosRequest(`/groups/${encodedGroupId}/favorites`, {
        method: 'POST',
        body: JSON.stringify({
          favoriteId,
          queueAction: 'REPLACE',
          action: 'REPLACE',
          playOnCompletion: false
        })
      });
    } catch (error) {
      if (error.status && error.status >= 400 && error.status < 500) {
        await sonosRequest(`/groups/${encodedGroupId}/favorites`, {
          method: 'POST',
          body: JSON.stringify({ favoriteId, action: 'REPLACE', playOnCompletion: false })
        });
      } else {
        throw error;
      }
    }

    await sonosRequest(`/groups/${encodedGroupId}/playback/playMode`, {
      method: 'POST',
      body: JSON.stringify({
        playModes: {
          shuffle: Boolean(shuffle),
          repeat: Boolean(repeat),
          crossfade: Boolean(crossfade)
        }
      })
    });

    await sonosRequest(`/groups/${encodedGroupId}/playback/play`, { method: 'POST' });

    activeFavoritesByGroup.set(groupId, {
      favoriteId,
      updatedAt: Date.now()
    });

    res.json({ status: 'ok', favoriteId });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/households/:householdId/players', async (req, res) => {
  const { householdId } = req.params;

  try {
    const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/groups`);
    const payload = await response.json();

    const groups = Array.isArray(payload.groups) ? payload.groups : [];
    const players = Array.isArray(payload.players) ? payload.players : [];

    const groupNames = new Map(
      groups.map((group) => [
        group.id ?? group.groupId ?? group.coordinatorId ?? null,
        group.name ?? group.displayName ?? ''
      ])
    );

    const batchSize = 5;
    for (let offset = 0; offset < players.length; offset += batchSize) {
      const slice = players.slice(offset, offset + batchSize);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        slice.map(async (player) => {
          if (!player?.id) {
            return;
          }

          try {
            const volumeResponse = await sonosRequest(
              `/players/${encodeURIComponent(player.id)}/playerVolume`
            );
            const volumePayload = await volumeResponse.json();
            const level =
              volumePayload.volume ??
              volumePayload?.volume?.volume ??
              volumePayload.level ??
              0;

            player.volume = Number.isFinite(Number(level)) ? Number(level) : 0;
            player.muted = Boolean(
              volumePayload.muted ?? volumePayload?.volume?.muted ?? false
            );
          } catch (error) {
            console.warn(
              `Failed to fetch player volume for ${player.id}`,
              error?.message ?? error
            );
            player.volume = Number.isFinite(Number(player.volume)) ? Number(player.volume) : 0;
            player.muted =
              typeof player.muted === 'boolean' ? player.muted : false;
          }

          player.groupName = groupNames.get(player.groupId) ?? '';
        })
      );
    }

    res.json({ groups, players });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/households/:householdId/groups-players', async (req, res) => {
  const { householdId } = req.params;

  try {
    const snapshot = await getHouseholdSnapshot(householdId);
    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    res.json({ groups, players });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/households/:householdId/create-all-group', async (req, res) => {
  const { householdId } = req.params;

  try {
    const snapshot = await getHouseholdSnapshot(householdId);
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    const playerIds = players.map((player) => player?.id).filter(Boolean);

    if (!playerIds.length) {
      return res.status(400).json({ error: 'No players found in household' });
    }

    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    let targetGroup = groups.find((g) => {
      const groupPlayerIds = g.playerIds || [];
      return groupPlayerIds.length === playerIds.length &&
             playerIds.every((id) => groupPlayerIds.includes(id));
    });

    if (!targetGroup) {
      const firstPlayer = players[0];
      if (!firstPlayer?.id) {
        return res.status(400).json({ error: 'No valid player found' });
      }

      const coordinatorId = firstPlayer.id;
      targetGroup = groups.find((g) => 
        g.coordinatorId === coordinatorId || 
        g.id === firstPlayer.groupId
      ) || { id: firstPlayer.groupId || coordinatorId, coordinatorId };

      const encodedGroupId = encodeURIComponent(targetGroup.id);
      await sonosRequest(`/groups/${encodedGroupId}/groups/setGroupMembers`, {
        method: 'POST',
        body: JSON.stringify({ playerIds })
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    res.json({ groupId: targetGroup.id, groupName: targetGroup.name || 'All Rooms' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/addPlayer', async (req, res) => {
  const { groupId } = req.params;
  const { playerId } = req.body ?? {};

  if (!playerId) {
    return res.status(400).json({ error: 'playerId is required.' });
  }

  try {
    const response = await sonosRequest(
      `/groups/${encodeURIComponent(groupId)}/groupMembers/addMember`,
      {
        method: 'POST',
        body: JSON.stringify({ playerId })
      }
    );

    const body = await response.text();
    res.status(response.status).send(body);
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/removePlayer', async (req, res) => {
  const { groupId } = req.params;
  const { playerId } = req.body ?? {};

  if (!playerId) {
    return res.status(400).json({ error: 'playerId is required.' });
  }

  try {
    const response = await sonosRequest(
      `/groups/${encodeURIComponent(groupId)}/groupMembers/removeMember`,
      {
        method: 'POST',
        body: JSON.stringify({ playerId })
      }
    );

    const body = await response.text();
    res.status(response.status).send(body);
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/players/:playerId/volume', async (req, res) => {
  const { playerId } = req.params;
  const { level } = req.body ?? {};
  const volumeLevel = Number(level);

  if (!Number.isFinite(volumeLevel) || volumeLevel < 0 || volumeLevel > 100) {
    return res.status(400).json({ error: 'Volume level must be between 0 and 100.' });
  }

  try {
    await sonosRequest(`/players/${encodeURIComponent(playerId)}/playerVolume`, {
      method: 'POST',
      body: JSON.stringify({ volume: volumeLevel })
    });
    res.json({ status: 'ok', volume: volumeLevel });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/spotify-playlist', async (req, res) => {
  const { groupId } = req.params;
  const { uri, shuffle, repeat, crossfade, householdId: householdHint } = req.body ?? {};

  if (!uri) {
    return res.status(400).json({ error: 'Spotify playlist URI is required.' });
  }

  const encodedGroupId = encodeURIComponent(groupId);

  try {
    const autogroupResult = await autogroupGroupMembers(groupId, householdHint);
    if (!autogroupResult.success) {
      console.warn(
        `Autogroup skipped for ${groupId}:`,
        autogroupResult.error ?? 'no household match'
      );
    }

    const householdForVolumes =
      autogroupResult.householdId ??
      (typeof householdHint === 'string' && householdHint.trim().length > 0
        ? householdHint.trim()
        : null);
    if (householdForVolumes) {
      await applyDefaultVolumes(householdForVolumes);
    }

    await sonosRequest(`/groups/${encodedGroupId}/playback/metadata`, {
      method: 'POST',
      body: JSON.stringify({ container: { id: uri, type: 'playlist' } })
    });

    if (shuffle) {
      await sonosRequest(`/groups/${encodedGroupId}/playback/shuffle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true })
      });
    }

    if (repeat) {
      const mode = typeof repeat === 'string' && repeat.length > 0 ? repeat : 'on';
      await sonosRequest(`/groups/${encodedGroupId}/playback/repeat`, {
        method: 'POST',
        body: JSON.stringify({ mode })
      });
    }

    if (crossfade) {
      try {
        await sonosRequest(`/groups/${encodedGroupId}/playback/crossfade`, {
          method: 'POST',
          body: JSON.stringify({ enabled: true })
        });
      } catch (error) {
        if (error.status && [400, 404, 409, 412, 501].includes(error.status)) {
          console.warn('Crossfade not enabled for this group:', error.message);
        } else {
          throw error;
        }
      }
    }

    await sonosRequest(`/groups/${encodedGroupId}/playback/play`, { method: 'POST' });

    res.json({ status: 'ok' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

async function resolveHouseholdId(candidateId) {
  if (candidateId) {
    return candidateId;
  }

  if (process.env.SONOS_HOUSEHOLD_ID) {
    return process.env.SONOS_HOUSEHOLD_ID;
  }

  const response = await sonosRequest('/households');
  const payload = await response.json();
  const households = Array.isArray(payload.households) ? payload.households : [];
  const first = households[0];

  if (!first || !first.id) {
    throw Object.assign(new Error('No Sonos households available'), { status: 404 });
  }

  return first.id;
}

async function listHouseholds() {
  const response = await sonosRequest('/households');
  const payload = await response.json();
  const households = Array.isArray(payload.households) ? payload.households : [];
  return households.map((household) => household?.id).filter(Boolean);
}

async function getHouseholdSnapshot(householdId) {
  const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/groups`);
  return response.json();
}

async function findGroupContext(groupId, householdHint) {
  const normalizedGroupId = groupId;
  const households = await listHouseholds();
  const hint =
    typeof householdHint === 'string' && householdHint.trim().length > 0
      ? householdHint.trim()
      : null;

  const ordered = [];
  if (hint && households.includes(hint)) {
    ordered.push(hint);
  }
  households.forEach((id) => {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  });

  for (const householdId of ordered) {
    try {
      const snapshot = await getHouseholdSnapshot(householdId);
      const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
      const match = groups.find((group) => {
        const identifiers = [
          group?.id,
          group?.groupId,
          group?.coordinatorId
        ].filter(Boolean);
        return identifiers.includes(normalizedGroupId);
      });

      if (match) {
        return {
          householdId,
          group: match,
          snapshot
        };
      }
    } catch (error) {
      console.warn(
        `Failed to inspect household ${householdId} when locating group ${groupId}:`,
        error?.message ?? error
      );
    }
  }

  return null;
}

async function autogroupGroupMembers(groupId, householdHint) {
  try {
    const context = await findGroupContext(groupId, householdHint);
    if (!context) {
      return { success: false, error: 'group_not_found' };
    }

    const { householdId, snapshot } = context;
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    const playerIds = players.map((player) => player?.id).filter(Boolean);

    if (!playerIds.length) {
      return { success: false, householdId, error: 'no_players' };
    }

    const encodedGroupId = encodeURIComponent(groupId);
    await sonosRequest(`/groups/${encodedGroupId}/groups/setGroupMembers`, {
      method: 'POST',
      body: JSON.stringify({ playerIds })
    });

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const current = await getHouseholdSnapshot(householdId);
        const allPlayers = Array.isArray(current.players) ? current.players : [];
        const everyoneInGroup = allPlayers.every(
          (player) => !player?.id || player.groupId === groupId
        );
        if (everyoneInGroup) {
          break;
        }
      } catch (error) {
        console.warn(
          `Failed to verify autogroup completion for ${groupId}:`,
          error?.message ?? error
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return { success: true, householdId };
  } catch (error) {
    console.warn(`Autogroup failed for ${groupId}:`, error?.message ?? error);
    return { success: false, error: error?.message ?? 'autogroup_failed' };
  }
}

async function applyDefaultVolumes(householdId) {
  if (!householdId) {
    return;
  }

  try {
    const response = await sonosFetch(`/households/${encodeURIComponent(householdId)}/groups`);
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const players = Array.isArray(payload.players) ? payload.players : [];

    const jobs = players
      .map((player) => {
        const target = speakerVolumes[player?.id];
        if (typeof target === 'number' && Number.isFinite(target)) {
          return sonosFetch(`/players/${encodeURIComponent(player.id)}/playerVolume`, {
            method: 'POST',
            body: JSON.stringify({ volume: target })
          });
        }
        return null;
      })
      .filter(Boolean);

    if (jobs.length) {
      await Promise.allSettled(jobs);
    }
  } catch (error) {
    console.warn(
      `Failed to apply default volumes for household ${householdId}:`,
      error?.message ?? error
    );
  }
}

async function clearGroupQueue(groupId) {
  const encodedGroupId = encodeURIComponent(groupId);
  const collectedIds = [];
  let supported = false;
  let lastError;

  try {
    let offset = 0;
    const pageSize = 200;

    while (true) {
      const response = await sonosRequest(
        `/groups/${encodedGroupId}/playback/queue/items?quantity=${pageSize}&offset=${offset}`
      );
      supported = true;

      if (response.status === 204) {
        break;
      }

      const payload = await response.json();
      const items = Array.isArray(payload.items) ? payload.items : [];

      if (!items.length) {
        break;
      }

      const ids = items.map((item) => item.id).filter(Boolean);
      collectedIds.push(...ids);

      if (!payload.nextId && !payload.nextPageToken && !payload.hasMore) {
        break;
      }

      offset += items.length;
    }
  } catch (error) {
    if (error.status && [404, 405].includes(error.status)) {
      return { success: false, supported: false, error: error.message || error.toString() };
    }

    lastError = error.message || error.toString();
    if (!supported) {
      return { success: false, supported: false, error: lastError };
    }
    throw error;
  }

  if (!collectedIds.length) {
    return { success: true, supported };
  }

  try {
    const chunkSize = 50;
    for (let index = 0; index < collectedIds.length; index += chunkSize) {
      const chunk = collectedIds.slice(index, index + chunkSize);
      await sonosRequest(`/groups/${encodedGroupId}/playback/queue/items/remove`, {
        method: 'POST',
        body: JSON.stringify({ itemIds: chunk })
      });
    }

    return { success: true, supported: true };
  } catch (error) {
    lastError = error.message || error.toString();
    return { success: false, supported: true, error: lastError };
  }
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI
  });

  const response = await fetch(`${SONOS_AUTH_BASE}/login/v3/oauth/access`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SONOS_CLIENT_ID}:${SONOS_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token exchange failed: ${text}`);
  }

  const payload = await response.json();
  storeTokens(payload);
  await saveTokens(tokens);
}

function storeTokens(tokenResponse) {
  tokens.access_token = tokenResponse.access_token ?? tokens.access_token ?? null;
  tokens.refresh_token = tokenResponse.refresh_token ?? tokens.refresh_token ?? null;
  const expiresIn = Number(tokenResponse.expires_in ?? 0);
  const bufferMs = 60 * 1000;
  tokens.expires_at = Date.now() + Math.max(expiresIn * 1000 - bufferMs, bufferMs);
}

async function refreshAccessToken() {
  if (!tokens.refresh_token) {
    throw Object.assign(new Error('Missing refresh token'), { status: 401 });
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  });

  const response = await fetch(`${SONOS_AUTH_BASE}/login/v3/oauth/access`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SONOS_CLIENT_ID}:${SONOS_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    tokens = await clearTokens();
    const text = await response.text();
    throw Object.assign(new Error(`Token refresh failed: ${text}`), { status: response.status });
  }

  const payload = await response.json();
  storeTokens(payload);
  await saveTokens(tokens);
}

async function ensureValidAccessToken() {
  // Ensure tokens are initialized
  await ensureInitialized();
  
  if (!tokens || !tokens.access_token) {
    throw Object.assign(new Error('Not authenticated with Sonos'), { status: 401 });
  }

  if (Date.now() >= tokens.expires_at) {
    await refreshAccessToken();
  }
}

async function sonosFetch(endpoint, options = {}) {
  await ensureValidAccessToken();

  const initialHeaders = {
    ...(options.headers ?? {})
  };

  if (options.body && !initialHeaders['Content-Type']) {
    initialHeaders['Content-Type'] = 'application/json; charset=utf-8';
  }

  const requestOptions = {
    ...options,
    headers: {
      ...initialHeaders,
      Authorization: `Bearer ${tokens.access_token}`
    }
  };

  let response = await fetch(`${SONOS_CONTROL_BASE}${endpoint}`, requestOptions);

  if (response.status === 401 && tokens.refresh_token) {
    await refreshAccessToken();
    requestOptions.headers.Authorization = `Bearer ${tokens.access_token}`;
    response = await fetch(`${SONOS_CONTROL_BASE}${endpoint}`, requestOptions);
  }

  if (response.status === 401) {
    tokens = await clearTokens();
  }

  return response;
}

async function sonosRequest(endpoint, options = {}) {
  await ensureValidAccessToken();

  const initialHeaders = {
    Accept: 'application/json',
    ...(options.headers ?? {})
  };

  if (options.body && !initialHeaders['Content-Type']) {
    initialHeaders['Content-Type'] = 'application/json; charset=utf-8';
  }

  const requestOptions = {
    ...options,
    headers: {
      ...initialHeaders,
      Authorization: `Bearer ${tokens.access_token}`
    }
  };

  let response = await fetch(`${SONOS_CONTROL_BASE}${endpoint}`, requestOptions);

  if (response.status === 401 && tokens.refresh_token) {
    await refreshAccessToken();
    requestOptions.headers.Authorization = `Bearer ${tokens.access_token}`;
    response = await fetch(`${SONOS_CONTROL_BASE}${endpoint}`, requestOptions);
    if (response.status === 401) {
      tokens = await clearTokens();
      throw Object.assign(new Error('Unauthorized request after refresh'), { status: 401 });
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw Object.assign(new Error(text || 'Sonos API request failed'), { status: response.status });
  }

  return response;
}

function handleProxyError(res, error) {
  const status = error.status ?? 500;
  const message = error.message ?? 'Unexpected error';

  if (status === 401) {
    tokens.access_token = null;
    tokens.expires_at = 0;
    tokens.refresh_token = null;
  }

  res.status(status).json({ error: message });
}

// Export app for serverless environments (Netlify Functions)
export { app };

// Only listen if not in serverless environment
if (process.env.NETLIFY !== 'true' && process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
  app.listen(PORT, () => {
    console.log(`Sonos controller server listening on port ${PORT}`);
  });
}
