import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTokens, saveTokens, clearTokens } from './tokenStore.js';
import { loadSpeakerVolumes, saveSpeakerVolumes } from './settingsStore.js';
import { loadPlaylistVibes, savePlaylistVibes } from './playlistVibesStore.js';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let tokens = await loadTokens();
let speakerVolumes = await loadSpeakerVolumes();
let playlistVibes = await loadPlaylistVibes();

const activeFavoritesByGroup = new Map();

let oauthState;

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
    const [statusResponse, metadataResponse] = await Promise.allSettled([
      sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/playbackState`).catch(() => null),
      sonosRequest(`/groups/${encodeURIComponent(groupId)}/playbackMetadata`).catch(() => null)
    ]);

    const playbackState = statusResponse.status === 'fulfilled' && statusResponse.value
      ? await statusResponse.value.json().catch(() => ({}))
      : {};

    const metadata = metadataResponse.status === 'fulfilled' && metadataResponse.value
      ? await metadataResponse.value.json().catch(() => ({}))
      : {};

    const volumeResponse = await sonosRequest(`/groups/${encodeURIComponent(groupId)}/groupVolume`).catch(() => null);
    const volume = volumeResponse ? await volumeResponse.json().catch(() => ({})) : {};

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

    res.json({
      playbackState: playbackState.playbackState || playbackState.state || 'STOPPED',
      currentItem: currentItem ? { ...currentItem, track } : null,
      item: currentItem ? { ...currentItem, track } : null,
      track: track,
      volume: volume.volume || volume.groupVolume || 0,
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

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const imageUrl = decodeURIComponent(url);
    
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const imageResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Sonos-Controller/1.0'
      }
    });

    if (!imageResponse.ok) {
      return res.status(imageResponse.status).json({ error: 'Failed to fetch image' });
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = await imageResponse.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(imageBuffer));
  } catch (error) {
    console.error('Image proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy image' });
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

app.get('/api/settings/volumes', (_req, res) => {
  res.json(speakerVolumes);
});

app.put('/api/settings/volumes', async (req, res) => {
  try {
    const incoming = req.body ?? {};
    const sanitized = {};
    Object.entries(incoming).forEach(([playerId, value]) => {
      const numeric = Number(value);
      if (!Number.isNaN(numeric)) {
        const normalized = Math.max(0, Math.min(100, numeric));
        sanitized[playerId] = normalized;
      }
    });

    speakerVolumes = await saveSpeakerVolumes(sanitized);
    res.json(speakerVolumes);
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
  if (!tokens.access_token) {
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

app.listen(PORT, () => {
  console.log(`Sonos controller server listening on port ${PORT}`);
});
