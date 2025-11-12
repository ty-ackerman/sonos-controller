import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTokens, saveTokens, clearTokens } from './tokenStore.js';
import { loadSpeakerVolumes, saveSpeakerVolumes } from './settingsStore.js';
import { loadPlaylistVibes, savePlaylistVibes } from './playlistVibesStore.js';
import {
  loadVibeTimeRules,
  saveVibeTimeRule,
  deleteVibeTimeRule
} from './vibeTimeRulesStore.js';
import { loadHiddenFavorites, setFavoriteHidden } from './hiddenFavoritesStore.js';
import { supabase } from './supabase.js';

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
let hiddenFavorites = null;
let initialized = false;
let initializationPromise = null;

// OAuth state management using database for serverless compatibility
async function saveOAuthState(state, deviceId) {
  console.error('[AUTH_DEBUG] saveOAuthState called', { state, deviceId, hasDeviceId: !!deviceId });
  
  try {
    const toSave = {
      state: state,
      device_id: deviceId,
      created_at: new Date().toISOString()
    };
    
    console.error('[AUTH_DEBUG] saveOAuthState: Upserting to oauth_states table', { state, deviceId, toSave });
    
    const { data, error } = await supabase
      .from('oauth_states')
      .upsert(toSave, { onConflict: 'state' })
      .select();
    
    if (error) {
      console.error('[AUTH_DEBUG] saveOAuthState: Supabase upsert ERROR', {
        state,
        deviceId,
        error: error.message,
        errorCode: error.code,
        errorDetails: error
      });
      throw error;
    }
    
    console.error('[AUTH_DEBUG] saveOAuthState: Supabase upsert SUCCESS', {
      state,
      deviceId,
      returnedData: data
    });
  } catch (error) {
    console.error('[AUTH_DEBUG] saveOAuthState: Exception caught', {
      state,
      deviceId,
      error: error.message,
      errorStack: error.stack
    });
    throw error;
  }
}

async function getDeviceIdFromState(state) {
  console.error('[AUTH_DEBUG] getDeviceIdFromState called', { state, hasState: !!state });
  
  try {
    console.error('[AUTH_DEBUG] getDeviceIdFromState: Querying oauth_states table', { state });
    const { data, error } = await supabase
      .from('oauth_states')
      .select('device_id')
      .eq('state', state)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
        console.error('[AUTH_DEBUG] getDeviceIdFromState: State not found', { state, errorCode: error.code });
        return null;
      }
      console.error('[AUTH_DEBUG] getDeviceIdFromState: Error retrieving OAuth state', {
        state,
        error: error.message,
        errorCode: error.code,
        errorDetails: error
      });
      return null;
    }
    
    const deviceId = data?.device_id || null;
    console.error('[AUTH_DEBUG] getDeviceIdFromState: Success', { state, deviceId, hasDeviceId: !!deviceId });
    return deviceId;
  } catch (error) {
    console.error('[AUTH_DEBUG] getDeviceIdFromState: Exception caught', {
      state,
      error: error.message,
      errorStack: error.stack
    });
    return null;
  }
}

async function deleteOAuthState(state) {
  console.error('[AUTH_DEBUG] deleteOAuthState called', { state, hasState: !!state });
  
  try {
    console.error('[AUTH_DEBUG] deleteOAuthState: Deleting from oauth_states table', { state });
    const { data, error } = await supabase
      .from('oauth_states')
      .delete()
      .eq('state', state)
      .select();
    
    if (error) {
      console.error('[AUTH_DEBUG] deleteOAuthState: Supabase delete ERROR', {
        state,
        error: error.message,
        errorCode: error.code,
        errorDetails: error
      });
    } else {
      console.error('[AUTH_DEBUG] deleteOAuthState: Supabase delete SUCCESS', {
        state,
        deletedRows: data?.length || 0,
        deletedData: data
      });
    }
  } catch (error) {
    console.error('[AUTH_DEBUG] deleteOAuthState: Exception caught', {
      state,
      error: error.message,
      errorStack: error.stack
    });
  }
}

// Initialize data stores (lazy loading for serverless)
// Note: tokens are now loaded per-request based on device_id, not during initialization
async function ensureInitialized() {
  if (initialized) {
    return;
  }
  
  if (initializationPromise) {
    return initializationPromise;
  }
  
  initializationPromise = (async () => {
    try {
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
      if (!hiddenFavorites) {
        hiddenFavorites = await loadHiddenFavorites();
        // Ensure hiddenFavorites is a Set
        if (!(hiddenFavorites instanceof Set)) {
          hiddenFavorites = new Set();
        }
      }
      initialized = true;
    } catch (error) {
      console.error('Error initializing data stores:', error);
      // Set defaults on error
      speakerVolumes = speakerVolumes || {};
      playlistVibes = playlistVibes || {};
      hiddenFavorites = hiddenFavorites || new Set();
      initialized = true;
      throw error;
    }
  })();
  
  return initializationPromise;
}

// Helper function to extract device_id from request
function getDeviceIdFromRequest(req) {
  return req.query.device_id || req.body.device_id;
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

app.get('/auth/sonos/login', async (req, res) => {
  const { device_id } = req.query;
  
  console.error('[AUTH_DEBUG] /auth/sonos/login called', { 
    device_id, 
    hasDeviceId: !!device_id,
    queryParams: req.query 
  });
  
  if (!device_id) {
    console.error('[AUTH_DEBUG] /auth/sonos/login: ERROR - Missing device_id');
    return res.redirect('/?auth=missing_device_id');
  }

  const oauthState = crypto.randomBytes(16).toString('hex');
  console.error('[AUTH_DEBUG] /auth/sonos/login: Generated OAuth state', { 
    device_id, 
    oauthState,
    stateLength: oauthState.length 
  });
  
  try {
    console.error('[AUTH_DEBUG] /auth/sonos/login: Saving OAuth state to database', { device_id, oauthState });
    await saveOAuthState(oauthState, device_id);
    console.error('[AUTH_DEBUG] /auth/sonos/login: OAuth state saved successfully', { device_id, oauthState });
  } catch (error) {
    console.error('[AUTH_DEBUG] /auth/sonos/login: Failed to save OAuth state', { 
      device_id, 
      oauthState,
      error: error.message,
      errorStack: error.stack,
      errorDetails: error 
    });
    return res.redirect('/?auth=error');
  }

  const params = new URLSearchParams({
    client_id: SONOS_CLIENT_ID,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state: oauthState
  });

  const redirectUrl = `${SONOS_AUTH_BASE}/login/v3/oauth?${params.toString()}`;
  console.error('[AUTH_DEBUG] /auth/sonos/login: Redirecting to Sonos OAuth', { 
    device_id, 
    oauthState,
    redirectUrl: redirectUrl.substring(0, 100) + '...' 
  });

  res.redirect(redirectUrl);
});

app.get('/auth/sonos/callback', async (req, res) => {
  const { code, state, error } = req.query;

  console.error('[AUTH_DEBUG] /auth/sonos/callback called', { 
    hasCode: !!code,
    hasState: !!state,
    hasError: !!error,
    error,
    codeLength: code?.length || 0,
    stateLength: state?.length || 0,
    queryParams: req.query
  });

  if (error) {
    console.error('[AUTH_DEBUG] /auth/sonos/callback: Sonos OAuth error returned', { error, state });
    return res.redirect('/?auth=error');
  }

  if (!code) {
    console.error('[AUTH_DEBUG] /auth/sonos/callback: ERROR - Missing code', { state });
    return res.redirect('/?auth=missing_code');
  }

  if (!state) {
    console.error('[AUTH_DEBUG] /auth/sonos/callback: ERROR - Missing state');
    return res.redirect('/?auth=invalid_state');
  }

  // Retrieve device_id from OAuth state
  console.error('[AUTH_DEBUG] /auth/sonos/callback: Retrieving device_id from OAuth state', { state });
  const deviceId = await getDeviceIdFromState(state);
  console.error('[AUTH_DEBUG] /auth/sonos/callback: Retrieved device_id from state', { 
    state, 
    deviceId, 
    hasDeviceId: !!deviceId 
  });
  
  if (!deviceId) {
    console.error('[AUTH_DEBUG] /auth/sonos/callback: ERROR - OAuth state not found or expired', { state });
    return res.redirect('/?auth=invalid_state');
  }

  try {
    console.error('[AUTH_DEBUG] /auth/sonos/callback: Exchanging code for tokens', { 
      deviceId, 
      codeLength: code.length,
      state 
    });
    await exchangeCodeForTokens(code, deviceId);
    console.error('[AUTH_DEBUG] /auth/sonos/callback: Token exchange successful', { deviceId, state });
    
    console.error('[AUTH_DEBUG] /auth/sonos/callback: Deleting OAuth state', { state, deviceId });
    await deleteOAuthState(state);
    console.error('[AUTH_DEBUG] /auth/sonos/callback: OAuth state deleted, redirecting to success', { deviceId });
    
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[AUTH_DEBUG] /auth/sonos/callback: ERROR - Failed to exchange code for tokens', {
      deviceId,
      state,
      error: err.message,
      errorStack: err.stack,
      errorDetails: err
    });
    await deleteOAuthState(state);
    res.redirect('/?auth=error');
  }
});

app.get('/auth/status', async (req, res) => {
  try {
    const { device_id } = req.query;
    
    if (!device_id) {
      return res.json({ loggedIn: false, expiresAt: 0 });
    }

    const deviceTokens = await loadTokens(device_id);
    let loggedIn = Boolean(deviceTokens.access_token) && Date.now() < (deviceTokens.expires_at || 0);

    if (loggedIn) {
      // Temporarily set tokens for sonosRequest validation
      const originalTokens = tokens;
      tokens = deviceTokens;
      try {
        await sonosRequest('/households', device_id);
      } catch (error) {
        if (error.status === 401) {
          await clearTokens(device_id);
          loggedIn = false;
        } else {
          console.warn('Failed to verify token during status check:', error?.message ?? error);
        }
      } finally {
        tokens = originalTokens;
      }
    }

    res.json({ loggedIn, expiresAt: loggedIn ? deviceTokens.expires_at || 0 : 0 });
  } catch (error) {
    console.error('Auth status check failed:', error?.message ?? error);
    res.json({ loggedIn: false });
  }
});

app.post('/auth/signout', async (req, res) => {
  try {
    const { device_id } = req.body;
    
    if (!device_id) {
      return res.status(400).json({ error: 'device_id is required' });
    }

    await clearTokens(device_id);
    res.json({ ok: true });
  } catch (error) {
    console.error('Sign out failed:', error);
    res.status(500).json({ error: 'Sign out failed' });
  }
});

app.get('/api/households', async (req, res) => {
  try {
    const deviceId = req.query.device_id;
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required' });
    }
    const response = await sonosRequest('/households', { deviceId });
    const payload = await response.json();
    res.json(payload);
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/households/:householdId/groups', async (req, res) => {
  const { householdId } = req.params;
  const deviceId = req.query.device_id;

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/groups`, { deviceId });
    const payload = await response.json();
    res.json(payload);
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/playpause', async (req, res) => {
  const { groupId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    await sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/togglePlayPause`, {
      method: 'POST',
      deviceId
    });
    res.json({ status: 'ok' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/volume', async (req, res) => {
  const { groupId } = req.params;
  const { volume } = req.body ?? {};
  const deviceId = getDeviceIdFromRequest(req);
  const level = Number(volume);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  if (!Number.isFinite(level) || level < 0 || level > 100) {
    return res.status(400).json({ error: 'Volume must be a number between 0 and 100.' });
  }

  try {
    const response = await sonosRequest(`/groups/${encodeURIComponent(groupId)}/groupVolume`, {
      method: 'POST',
      body: JSON.stringify({ volume: level }),
      deviceId
    });
    const responseData = await response.json().catch(() => ({}));
    
    res.json({ status: 'ok', volume: level });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/next', async (req, res) => {
  const { groupId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    await sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/skipToNextTrack`, {
      method: 'POST',
      deviceId
    });
    res.json({ status: 'ok' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/previous', async (req, res) => {
  const { groupId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    await sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/skipToPreviousTrack`, {
      method: 'POST',
      deviceId
    });
    res.json({ status: 'ok' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/groups/:groupId/playback/status', async (req, res) => {
  const { groupId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);
  const preferredHousehold =
    typeof req.query.householdId === 'string' && req.query.householdId.trim().length > 0
      ? req.query.householdId.trim()
      : undefined;

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    // Try playbackStatus endpoint first (more reliable), fallback to playbackState
    const [statusResponse, metadataResponse] = await Promise.allSettled([
      sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/playbackStatus`, { deviceId }).catch(() => {
        // Fallback to playbackState if playbackStatus fails
        return sonosRequest(`/groups/${encodeURIComponent(groupId)}/playback/playbackState`, { deviceId }).catch((err) => {
          console.error('[PlaybackStatus] Both playbackStatus and playbackState requests failed:', err.message);
          return null;
        });
      }),
      sonosRequest(`/groups/${encodeURIComponent(groupId)}/playbackMetadata`, { deviceId }).catch((err) => {
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

    const volumeResponse = await sonosRequest(`/groups/${encodeURIComponent(groupId)}/groupVolume`, { deviceId }).catch(() => null);
    const volume = volumeResponse ? await volumeResponse.json().catch(() => ({})) : {};
    
    const currentItem = metadata.currentItem || metadata.item || null;
    const container = currentItem?.container || metadata.container || null;
    
    const normalizeField = (field) => {
      if (!field) return null;
      if (typeof field === 'string') return field;
      if (typeof field === 'object') {
        return field.name || field.value || field.text || null;
      }
      return String(field);
    };
    
    let track = null;
    let playlistName = null;
    let playlistImageUrl = null;
    
    if (currentItem) {
      track = currentItem.track || currentItem.container?.metadata || currentItem;
      
      if (track && typeof track === 'object') {
        // Extract replayGain if available (floating-point number, typically -13 to +13 dB)
        let replayGain = null;
        if (track.replayGain !== undefined && track.replayGain !== null) {
          const gainValue = Number(track.replayGain);
          if (Number.isFinite(gainValue)) {
            replayGain = gainValue;
          }
        }

        // Extract track image from images array (primary source for cover art)
        let trackImageUrl = null;
        if (track.images && Array.isArray(track.images) && track.images.length > 0) {
          trackImageUrl = normalizeField(track.images[0]?.url);
        } else {
          trackImageUrl = normalizeField(track.imageUrl) || 
                         normalizeField(track.albumArtUri) || 
                         normalizeField(track.albumArtURL);
        }

        track = {
          name: normalizeField(track.name) || normalizeField(track.title),
          artist: normalizeField(track.artist) || normalizeField(track.albumArtist) || normalizeField(track.creator),
          album: normalizeField(track.album) || normalizeField(track.albumName),
          imageUrl: trackImageUrl,
          replayGain: replayGain,
          images: track.images, // Preserve images array for client
          ...track
        };
      }
    }
    
    // Extract playlist name from container (primary source)
    if (container && typeof container === 'object') {
      playlistName = normalizeField(container.name) || 
                     normalizeField(container.title) ||
                     normalizeField(container.service?.name);
      
      // Container images as fallback for playlist cover art
      if (container.images && Array.isArray(container.images) && container.images.length > 0) {
        playlistImageUrl = normalizeField(container.images[0]?.url);
      } else {
        playlistImageUrl = normalizeField(container.imageUrl) ||
                           normalizeField(container.albumArtUri) ||
                           normalizeField(container.albumArtURL);
      }
    }
    
    // Try to find matching favorite for UI highlighting and as fallback for playlist name
    let activeFavoriteId = null;
    let activeFavorite = null;
    if (container?.id || container?.serviceId) {
      const containerId = container.id || container.serviceId;
      try {
        const favoriteMatch = await findFavoriteByContainerId(containerId, preferredHousehold, deviceId);
        if (favoriteMatch) {
          activeFavoriteId = favoriteMatch.id;
          // Use favorite name as fallback if container doesn't have name
          if (!playlistName) {
            playlistName = favoriteMatch.name;
          }
          // Use favorite image as fallback if container doesn't have image
          if (!playlistImageUrl && favoriteMatch.imageUrl) {
            playlistImageUrl = favoriteMatch.imageUrl;
          }
          activeFavorite = {
            id: favoriteMatch.id,
            name: playlistName || favoriteMatch.name,
            imageUrl: playlistImageUrl || favoriteMatch.imageUrl || null
          };
        }
      } catch (error) {
        // Non-fatal
        console.warn('[SonosData] Failed to find favorite match:', error.message);
      }
    }
    
    // If we have playlist info but no favorite match, still create activeFavorite object
    if (playlistName && !activeFavorite) {
      activeFavorite = {
        id: null,
        name: playlistName,
        imageUrl: playlistImageUrl || null
      };
    }

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
    // Ensure finalPlaybackState is a string before calling includes()
    const stateString = String(finalPlaybackState || 'STOPPED');
    if (stateString.includes('PLAYING')) {
      finalPlaybackState = 'PLAYING';
    } else if (stateString.includes('PAUSED')) {
      finalPlaybackState = 'PAUSED';
    } else if (stateString.includes('IDLE')) {
      // IDLE typically means paused for streaming content
      finalPlaybackState = 'PAUSED';
    } else if (stateString.includes('STOPPED') || stateString === 'STOPPED') {
      finalPlaybackState = 'STOPPED';
    } else {
      finalPlaybackState = 'STOPPED';
    }

    // Fallback: If we have a currentItem but playbackState says STOPPED, 
    // assume it's playing (the API sometimes returns incorrect state)
    if (finalPlaybackState === 'STOPPED' && currentItem) {
      finalPlaybackState = 'PLAYING';
    }
    
    // If playback stopped and no current item, clear active favorite
    const finalActiveFavoriteId = (finalPlaybackState === 'STOPPED' && !currentItem) ? null : (activeFavorite?.id || null);
    const finalActiveFavorite = (finalPlaybackState === 'STOPPED' && !currentItem) ? null : activeFavorite;
    

    res.json({
      playbackState: finalPlaybackState,
      currentItem: currentItem ? { ...currentItem, track } : null,
      item: currentItem ? { ...currentItem, track } : null,
      track: track,
      volume: volume.volume || volume.groupVolume || 0,
      activeFavoriteId: finalActiveFavoriteId,
      activeFavorite: finalActiveFavorite,
      container: container || metadata.container || null, // Explicitly include container for playlist name
      ...playbackState,
      ...metadata
    });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/players/:playerId/volume', async (req, res) => {
  const { playerId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    const response = await sonosRequest(
      `/players/${encodeURIComponent(playerId)}/playerVolume`,
      { deviceId }
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
    console.error('[ImageProxy] Missing or invalid URL parameter');
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const imageUrl = decodeURIComponent(url);
    
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      console.error('[ImageProxy] Invalid URL format (not http/https):', imageUrl);
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Check if this is a local network IP - serverless functions can't access these
    const isLocalNetwork = /^http:\/\/192\.168\.|^http:\/\/10\.|^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\.|^http:\/\/127\.|^http:\/\/localhost/.test(imageUrl);
    
    if (isLocalNetwork) {
      console.warn('[ImageProxy] Local network URL detected - server may not be able to access:', imageUrl);
      // Return a 503 to indicate the server can't access local network
      // Client should handle this by fetching directly
      return res.status(503).json({ 
        error: 'Local network URL - server cannot access',
        localNetwork: true,
        originalUrl: imageUrl
      });
    }

    const imageResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Sonos-Controller/1.0',
        'Accept': 'image/*'
      },
      // Add timeout for image requests
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });

    if (!imageResponse.ok) {
      console.error(`[ImageProxy] Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText} for ${imageUrl}`);
      return res.status(imageResponse.status).json({ error: 'Failed to fetch image' });
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    
    // Validate it's actually an image
    if (!contentType.startsWith('image/')) {
      console.error(`[ImageProxy] Non-image content type: ${contentType} for ${imageUrl}`);
      return res.status(400).json({ error: 'URL does not point to an image' });
    }

    const imageBuffer = await imageResponse.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    // Disable caching for local network images to prevent stale images
    // Use no-cache instead of no-store to allow revalidation but prevent stale cache
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(imageBuffer));
  } catch (error) {
    console.error('[ImageProxy] Error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to proxy image', details: error.message });
  }
});

app.get('/api/favorites', async (req, res) => {
  try {
    const deviceId = getDeviceIdFromRequest(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required' });
    }

    const preferredHousehold =
      typeof req.query.householdId === 'string' && req.query.householdId.trim().length > 0
        ? req.query.householdId.trim()
        : undefined;
    const householdId = await resolveHouseholdId(preferredHousehold);
    const groupId =
      typeof req.query.groupId === 'string' && req.query.groupId.trim().length > 0
        ? req.query.groupId.trim()
        : undefined;

    // Check if we should filter hidden favorites (default: true for Controls section)
    const includeHidden = req.query.includeHidden === 'true';

    const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/favorites`, { deviceId });
    const payload = await response.json();

    // Reload hidden favorites to ensure we have the latest state
    hiddenFavorites = await loadHiddenFavorites();
    if (!(hiddenFavorites instanceof Set)) {
      hiddenFavorites = new Set();
    }

    // Filter out hidden favorites if not including them
    if (!includeHidden && payload.items && Array.isArray(payload.items)) {
      payload.items = payload.items.filter((item) => !hiddenFavorites.has(item.id));
    }

    res.json({ ...payload, householdId });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.put('/api/favorites/:favoriteId/hidden', async (req, res) => {
  try {
    const { favoriteId } = req.params;
    if (!favoriteId) {
      return res.status(400).json({ error: 'favoriteId is required.' });
    }

    const { hidden } = req.body;
    if (typeof hidden !== 'boolean') {
      return res.status(400).json({ error: 'hidden must be a boolean value.' });
    }

    await setFavoriteHidden(favoriteId, hidden);

    // Reload hidden favorites to ensure we have the latest state
    hiddenFavorites = await loadHiddenFavorites();
    if (!(hiddenFavorites instanceof Set)) {
      hiddenFavorites = new Set();
    }

    res.json({ success: true, favoriteId, hidden });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/favorites/:favoriteId/hidden', async (req, res) => {
  try {
    const { favoriteId } = req.params;
    if (!favoriteId) {
      return res.status(400).json({ error: 'favoriteId is required.' });
    }

    // Reload hidden favorites to ensure we have the latest state
    hiddenFavorites = await loadHiddenFavorites();
    if (!(hiddenFavorites instanceof Set)) {
      hiddenFavorites = new Set();
    }

    const isHidden = hiddenFavorites.has(favoriteId);
    res.json({ favoriteId, hidden: isHidden });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.delete('/api/favorites/:favoriteId', async (req, res) => {
  try {
    const { favoriteId } = req.params;
    if (!favoriteId) {
      return res.status(400).json({ error: 'favoriteId is required.' });
    }

    // Since Sonos API doesn't support deleting favorites, we hide it instead
    await setFavoriteHidden(favoriteId, true);

    // No need to remove from cache - status endpoint finds favorites on-demand

    // Reload hidden favorites to ensure we have the latest state
    hiddenFavorites = await loadHiddenFavorites();
    if (!(hiddenFavorites instanceof Set)) {
      hiddenFavorites = new Set();
    }

    res.json({ success: true, favoriteId, hidden: true });
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

// Vibe time rules endpoints
app.get('/api/vibe-time-rules', async (_req, res) => {
  try {
    const rules = await loadVibeTimeRules();
    res.json(rules);
  } catch (error) {
    console.error('Error loading vibe time rules:', error);
    res.status(500).json({ error: 'Failed to load vibe time rules', detail: error?.message ?? String(error) });
  }
});

app.post('/api/vibe-time-rules', async (req, res) => {
  try {
    const rule = req.body ?? {};
    const saved = await saveVibeTimeRule(rule);
    res.json(saved);
  } catch (error) {
    res
      .status(400)
      .json({ error: 'vibe_time_rule_save_failed', detail: error?.message ?? String(error) });
  }
});

app.put('/api/vibe-time-rules/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid rule ID' });
    }
    const rule = { ...req.body, id };
    const saved = await saveVibeTimeRule(rule);
    res.json(saved);
  } catch (error) {
    res
      .status(400)
      .json({ error: 'vibe_time_rule_save_failed', detail: error?.message ?? String(error) });
  }
});

app.delete('/api/vibe-time-rules/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid rule ID' });
    }
    await deleteVibeTimeRule(id);
    res.json({ success: true });
  } catch (error) {
    res
      .status(400)
      .json({ error: 'vibe_time_rule_delete_failed', detail: error?.message ?? String(error) });
  }
});

// Helper function to check if a time range contains an hour
// Note: When endHour is 0 (12:00 AM), it means "ends before midnight" (exclusive of hour 0)
// So a rule from 19-0 means 7:00 PM through 11:59 PM (hours 19-23), NOT including hour 0
function timeRangeContainsHour(startHour, endHour, hour) {
  // Special case: if endHour is 0 (12AM), the rule applies until 11:59 PM (hour 23)
  // This means hour 23 is included, but hour 0 is NOT included
  if (endHour === 0 && startHour > 0) {
    // Rule ends at midnight - include hour 23, exclude hour 0
    return hour >= startHour && hour <= 23;
  }
  
  // For normal ranges, make endHour exclusive (e.g., 17-23 means 5:00 PM through 10:59 PM, NOT including 11:00 PM)
  if (startHour <= endHour) {
    // Normal range (e.g., 7-12 means 7:00 AM through 11:59 AM, NOT including 12:00 PM)
    // Make endHour exclusive: hour must be < endHour (not <=)
    return hour >= startHour && hour < endHour;
  } else {
    // Wraps around midnight (e.g., 22-6 means 10:00 PM through 5:59 AM, NOT including 6:00 AM)
    // This includes hours >= startHour (evening) OR hours < endHour (early morning, exclusive)
    return hour >= startHour || hour < endHour;
  }
}

// Helper function to get recommended playlists based on current time
async function getRecommendedPlaylists(householdId, userHour, userDay, timezoneOffset, deviceId) {
  try {
    // Use user's local time if provided, otherwise fall back to server time
    let currentHour, currentDay;
    if (typeof userHour === 'number' && typeof userDay === 'number') {
      // Use client-provided time (user's local timezone)
      currentHour = userHour;
      currentDay = userDay;
      // Removed console.log for recommendations time
    } else {
      // Fallback to server time (for backward compatibility)
      const now = new Date();
      currentHour = now.getHours();
      currentDay = now.getDay();
      // Removed console.log for server time
    }

    // Load all time rules
    const allRules = await loadVibeTimeRules();
    // Removed console.log for recommendations rules

    // Separate base schedule rules and override rules
    const baseRules = allRules.filter(r => r.rule_type === 'base');
    const overrideRules = allRules.filter(r => r.rule_type === 'override');
    
    // Find base rules that match current time
    const matchingBaseRules = baseRules.filter(rule => {
      return timeRangeContainsHour(rule.start_hour, rule.end_hour, currentHour);
    });

    // Find override rules for current day that match current time
    const matchingOverrideRules = overrideRules.filter(rule => {
      // Override must be for current day (override rules have exactly one day)
      if (!rule.days || !Array.isArray(rule.days) || rule.days.length !== 1) {
        return false;
      }
      if (rule.days[0] !== currentDay) {
        return false;
      }
      // Override must match current time
      return timeRangeContainsHour(rule.start_hour, rule.end_hour, currentHour);
    });

    // Merge logic: Overrides replace base rules for overlapping time
    // Since we're checking a single hour, if any override matches, use overrides
    // Otherwise, use base rules
    let activeRules = [];
    if (matchingOverrideRules.length > 0) {
      // Override takes precedence - use override rules
      activeRules = matchingOverrideRules;
    } else {
      // No override matches - use base rules
      activeRules = matchingBaseRules;
    }

    // Collect all allowed vibes from active rules
    const allowedVibes = new Set();
    activeRules.forEach((rule) => {
      rule.allowed_vibes.forEach((vibe) => allowedVibes.add(vibe));
    });

    // If no rules match, return empty recommendations
    if (allowedVibes.size === 0) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      console.warn(`[Recommendations] No rules match current time: ${currentHour}:00 on ${dayNames[currentDay]}`);
      
      return {
        primary: null,
        alternatives: [],
        currentRule: null,
        debug: {
          currentHour,
          currentDay,
          totalRules: allRules.length,
          baseRulesCount: baseRules.length,
          overrideRulesCount: overrideRules.length,
          matchingBaseRulesCount: matchingBaseRules.length,
          matchingOverrideRulesCount: matchingOverrideRules.length,
          activeRulesCount: activeRules.length,
          activeRuleIds: activeRules.map(r => r.id),
          activeRuleTypes: activeRules.map(r => r.rule_type),
          allBaseRules: baseRules.map(r => ({ id: r.id, time: `${r.start_hour}-${r.end_hour}`, vibes: r.allowed_vibes })),
          allOverrideRules: overrideRules.map(r => ({ 
            id: r.id, 
            time: `${r.start_hour}-${r.end_hour}`, 
            day: r.days && r.days.length > 0 ? dayNames[r.days[0]] : 'unknown',
            vibes: r.allowed_vibes 
          }))
        }
      };
    }

    // Get all favorites
    const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/favorites`, { deviceId });
    const payload = await response.json();
    let favorites = Array.isArray(payload.items) ? payload.items : [];

    // Filter out hidden favorites
    await ensureInitialized();
    if (!hiddenFavorites) {
      hiddenFavorites = await loadHiddenFavorites();
      if (!(hiddenFavorites instanceof Set)) {
        hiddenFavorites = new Set();
      }
    }
    favorites = favorites.filter((favorite) => !hiddenFavorites.has(favorite.id));

    // Load playlist vibes
    const vibes = await loadPlaylistVibes();

    // Filter favorites by allowed vibes
    const matchingPlaylists = favorites.filter((favorite) => {
      const vibe = vibes[favorite.id];
      const matches = vibe && allowedVibes.has(vibe);
      if (matches) {
      }
      return matches;
    });


    if (matchingPlaylists.length === 0) {
      return {
        primary: null,
        alternatives: [],
        currentRule: activeRules.length > 0 ? activeRules[0] : null,
        debug: {
          currentHour,
          currentDay,
          totalRules: allRules.length,
          baseRulesCount: baseRules.length,
          overrideRulesCount: overrideRules.length,
          matchingBaseRulesCount: matchingBaseRules.length,
          matchingOverrideRulesCount: matchingOverrideRules.length,
          activeRulesCount: activeRules.length,
          activeRuleIds: activeRules.map(r => r.id),
          activeRuleTypes: activeRules.map(r => r.rule_type)
        }
      };
    }

    // Deterministically select primary recommendation based on active rule and date
    // This ensures the same playlist is recommended for the entire time period
    // and persists across different browsers/sessions
    let seedValue = 0;
    if (activeRules.length > 0) {
      // Use the user's local date (if provided) or server date
      // Combine with rule ID to get a consistent recommendation for the day
      let dateString;
      if (typeof userDay === 'number' && timezoneOffset !== undefined) {
        // Calculate date based on user's timezone
        // We have userDay (0-6) and timezoneOffset, but we need the actual date
        // For simplicity, use server date but this will be consistent for the same rule+day combination
        const now = new Date();
        // Adjust for timezone offset to get user's local date
        const userLocalTime = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
        dateString = `${userLocalTime.getFullYear()}-${String(userLocalTime.getMonth() + 1).padStart(2, '0')}-${String(userLocalTime.getDate()).padStart(2, '0')}`;
      } else {
        // Fallback to server date
        const now = new Date();
        dateString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      }
      
      // Create a deterministic seed from rule ID and date
      // Sort rule IDs to ensure consistency when multiple rules are active
      const ruleIds = activeRules.map(r => r.id).sort().join(',');
      const seedString = `${ruleIds}-${dateString}`;
      
      // Simple hash function to convert string to number
      for (let i = 0; i < seedString.length; i++) {
        const char = seedString.charCodeAt(i);
        seedValue = ((seedValue << 5) - seedValue) + char;
        seedValue = seedValue & seedValue; // Convert to 32-bit integer
      }
      
      // Make it positive
      seedValue = Math.abs(seedValue);
      
    }
    
    // Use seeded selection (deterministic but appears random)
    const primaryIndex = seedValue % matchingPlaylists.length;
    const primary = matchingPlaylists[primaryIndex];
    const alternatives = matchingPlaylists.filter((_, index) => index !== primaryIndex);
    

    // Include debug info about which rules were considered
    const debugInfo = {
      currentHour,
      currentDay,
      totalRules: allRules.length,
      baseRulesCount: baseRules.length,
      overrideRulesCount: overrideRules.length,
      matchingBaseRulesCount: matchingBaseRules.length,
      matchingOverrideRulesCount: matchingOverrideRules.length,
      activeRulesCount: activeRules.length,
      activeRuleIds: activeRules.map(r => r.id),
      activeRuleTypes: activeRules.map(r => r.rule_type),
      allRules: allRules.map(r => ({
        id: r.id,
        type: r.rule_type,
        time: `${r.start_hour}-${r.end_hour}`,
        days: r.days ? r.days.join(',') : 'all',
        vibes: r.allowed_vibes.join(',')
      }))
    };

    return {
      primary,
      alternatives,
      currentRule: activeRules.length > 0 ? activeRules[0] : null,
      debug: debugInfo
    };
  } catch (error) {
    console.error('Error getting recommended playlists:', error);
    throw error;
  }
}

app.get('/api/playlist-recommendations', async (req, res) => {
  try {
    const deviceId = getDeviceIdFromRequest(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required' });
    }

    const preferredHousehold =
      typeof req.query.householdId === 'string' && req.query.householdId.trim().length > 0
        ? req.query.householdId.trim()
        : undefined;
    const householdId = await resolveHouseholdId(preferredHousehold, deviceId);

    // Get user's local time from query params (if provided)
    const userHour = req.query.hour ? parseInt(req.query.hour, 10) : undefined;
    const userDay = req.query.day ? parseInt(req.query.day, 10) : undefined;
    const timezoneOffset = req.query.timezoneOffset ? parseFloat(req.query.timezoneOffset) : undefined;

    // Validate hour and day if provided
    if (userHour !== undefined && (userHour < 0 || userHour > 23 || isNaN(userHour))) {
      return res.status(400).json({ error: 'Invalid hour parameter (must be 0-23)' });
    }
    if (userDay !== undefined && (userDay < 0 || userDay > 6 || isNaN(userDay))) {
      return res.status(400).json({ error: 'Invalid day parameter (must be 0-6)' });
    }

    const recommendations = await getRecommendedPlaylists(householdId, userHour, userDay, timezoneOffset, deviceId);
    res.json(recommendations);
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/favorites/play', async (req, res) => {
  const { groupId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);
  const {
    favoriteId,
    shuffle = true,
    repeat = true,
    crossfade = true,
    householdId: householdHint
  } = req.body ?? {};

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  if (!favoriteId) {
    return res.status(400).json({ error: 'favoriteId is required.' });
  }

  const encodedGroupId = encodeURIComponent(groupId);

  try {
    const autogroupResult = await autogroupGroupMembers(groupId, householdHint, deviceId);
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
      await applyDefaultVolumes(householdForVolumes, deviceId);
    }

    const clearResult = await clearGroupQueue(groupId, deviceId);
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
        }),
        deviceId
      });
    } catch (error) {
      if (error.status && error.status >= 400 && error.status < 500) {
        await sonosRequest(`/groups/${encodedGroupId}/favorites`, {
          method: 'POST',
          body: JSON.stringify({ favoriteId, action: 'REPLACE', playOnCompletion: false }),
          deviceId
        });
      } else {
        throw error;
      }
    }

    // No need to cache favorite - status endpoint will find it on-demand by matching container

    await sonosRequest(`/groups/${encodedGroupId}/playback/playMode`, {
      method: 'POST',
      body: JSON.stringify({
        playModes: {
          shuffle: Boolean(shuffle),
          repeat: Boolean(repeat),
          crossfade: Boolean(crossfade)
        }
      }),
      deviceId
    });

    await sonosRequest(`/groups/${encodedGroupId}/playback/play`, { method: 'POST', deviceId });

    res.json({ status: 'ok', favoriteId });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.get('/api/households/:householdId/players', async (req, res) => {
  const { householdId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/groups`, { deviceId });
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
              `/players/${encodeURIComponent(player.id)}/playerVolume`,
              { deviceId }
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
  const deviceId = getDeviceIdFromRequest(req);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    const snapshot = await getHouseholdSnapshot(householdId, deviceId);
    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    res.json({ groups, players });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/households/:householdId/create-all-group', async (req, res) => {
  const { householdId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    const snapshot = await getHouseholdSnapshot(householdId, deviceId);
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
        body: JSON.stringify({ playerIds }),
        deviceId
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
  const deviceId = getDeviceIdFromRequest(req);
  const { playerId } = req.body ?? {};

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  if (!playerId) {
    return res.status(400).json({ error: 'playerId is required.' });
  }

  try {
    const response = await sonosRequest(
      `/groups/${encodeURIComponent(groupId)}/groupMembers/addMember`,
      {
        method: 'POST',
        body: JSON.stringify({ playerId }),
        deviceId
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
  const deviceId = getDeviceIdFromRequest(req);
  const { playerId } = req.body ?? {};

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  if (!playerId) {
    return res.status(400).json({ error: 'playerId is required.' });
  }

  try {
    const response = await sonosRequest(
      `/groups/${encodeURIComponent(groupId)}/groupMembers/removeMember`,
      {
        method: 'POST',
        body: JSON.stringify({ playerId }),
        deviceId
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
  const deviceId = getDeviceIdFromRequest(req);
  const { level } = req.body ?? {};
  const volumeLevel = Number(level);

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  if (!Number.isFinite(volumeLevel) || volumeLevel < 0 || volumeLevel > 100) {
    return res.status(400).json({ error: 'Volume level must be between 0 and 100.' });
  }

  try {
    const response = await sonosRequest(`/players/${encodeURIComponent(playerId)}/playerVolume`, {
      method: 'POST',
      body: JSON.stringify({ volume: volumeLevel }),
      deviceId
    });
    let responseData = {};
    try {
      responseData = await response.json();
    } catch (e) {
      // Response might not be JSON
    }
    
    res.json({ status: 'ok', volume: volumeLevel });
  } catch (error) {
    handleProxyError(res, error);
  }
});

app.post('/api/groups/:groupId/spotify-playlist', async (req, res) => {
  const { groupId } = req.params;
  const deviceId = getDeviceIdFromRequest(req);
  const { uri, shuffle, repeat, crossfade, householdId: householdHint } = req.body ?? {};

  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  if (!uri) {
    return res.status(400).json({ error: 'Spotify playlist URI is required.' });
  }

  const encodedGroupId = encodeURIComponent(groupId);

  try {
    const autogroupResult = await autogroupGroupMembers(groupId, householdHint, deviceId);
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
      await applyDefaultVolumes(householdForVolumes, deviceId);
    }

    await sonosRequest(`/groups/${encodedGroupId}/playback/metadata`, {
      method: 'POST',
      body: JSON.stringify({ container: { id: uri, type: 'playlist' } }),
      deviceId
    });

    if (shuffle) {
      await sonosRequest(`/groups/${encodedGroupId}/playback/shuffle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
        deviceId
      });
    }

    if (repeat) {
      const mode = typeof repeat === 'string' && repeat.length > 0 ? repeat : 'on';
      await sonosRequest(`/groups/${encodedGroupId}/playback/repeat`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
        deviceId
      });
    }

    if (crossfade) {
      try {
        await sonosRequest(`/groups/${encodedGroupId}/playback/crossfade`, {
          method: 'POST',
          body: JSON.stringify({ enabled: true }),
          deviceId
        });
      } catch (error) {
        if (error.status && [400, 404, 409, 412, 501].includes(error.status)) {
          console.warn('Crossfade not enabled for this group:', error.message);
        } else {
          throw error;
        }
      }
    }

    await sonosRequest(`/groups/${encodedGroupId}/playback/play`, { method: 'POST', deviceId });

    res.json({ status: 'ok' });
  } catch (error) {
    handleProxyError(res, error);
  }
});

async function resolveHouseholdId(candidateId, deviceId) {
  if (candidateId) {
    return candidateId;
  }

  if (process.env.SONOS_HOUSEHOLD_ID) {
    return process.env.SONOS_HOUSEHOLD_ID;
  }

  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 401 });
  }

  const response = await sonosRequest('/households', { deviceId });
  const payload = await response.json();
  const households = Array.isArray(payload.households) ? payload.households : [];
  const first = households[0];

  if (!first || !first.id) {
    throw Object.assign(new Error('No Sonos households available'), { status: 404 });
  }

  return first.id;
}

async function listHouseholds(deviceId) {
  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 401 });
  }
  const response = await sonosRequest('/households', { deviceId });
  const payload = await response.json();
  const households = Array.isArray(payload.households) ? payload.households : [];
  return households.map((household) => household?.id).filter(Boolean);
}

// Find favorite by container ID (for UI highlighting only - display uses container metadata directly)
async function findFavoriteByContainerId(containerId, preferredHousehold, deviceId) {
  if (!containerId) {
    return null;
  }

  if (!deviceId) {
    return null;
  }

  try {
    const normalizeImageUrl = (img) => {
      if (!img) return null;
      if (typeof img === 'string') return img;
      if (typeof img === 'object') {
        return img.url || img.value || null;
      }
      return null;
    };

    // Try preferred household first
    let householdId = preferredHousehold ? await resolveHouseholdId(preferredHousehold, deviceId).catch(() => null) : null;
    let favorite = null;

    if (householdId) {
      try {
        const favoritesResponse = await sonosRequest(`/households/${encodeURIComponent(householdId)}/favorites`, { deviceId }).catch(() => null);
        if (favoritesResponse) {
          const favoritesData = await favoritesResponse.json().catch(() => ({}));
          const favorites = Array.isArray(favoritesData.items) ? favoritesData.items : [];
          
          // Match by container ID
          favorite = favorites.find((f) => {
            const favoriteContainerId = f.container?.id || f.serviceId || f.id;
            return favoriteContainerId === containerId;
          });

          if (favorite) {
            const imageUrl = normalizeImageUrl(favorite.imageUrl) ||
              (favorite.images && favorite.images.length ? normalizeImageUrl(favorite.images[0]?.url) : null) ||
              normalizeImageUrl(favorite.container?.imageUrl);

            return {
              id: favorite.id,
              name: favorite.name || null,
              imageUrl: imageUrl
            };
          }
        }
      } catch (error) {
        // Silent - will try other households
      }
    }

    // If not found in preferred household, try all households
    try {
      const households = await listHouseholds(deviceId);
      for (const hId of households) {
        if (hId === householdId) continue; // Skip already checked household
        try {
          const favoritesResponse = await sonosRequest(`/households/${encodeURIComponent(hId)}/favorites`, { deviceId }).catch(() => null);
          if (favoritesResponse) {
            const favoritesData = await favoritesResponse.json().catch(() => ({}));
            const favorites = Array.isArray(favoritesData.items) ? favoritesData.items : [];
            
            // Match by container ID
            favorite = favorites.find((f) => {
              const favoriteContainerId = f.container?.id || f.serviceId || f.id;
              return favoriteContainerId === containerId;
            });

            if (favorite) {
              const imageUrl = normalizeImageUrl(favorite.imageUrl) ||
                (favorite.images && favorite.images.length ? normalizeImageUrl(favorite.images[0]?.url) : null) ||
                normalizeImageUrl(favorite.container?.imageUrl);

              return {
                id: favorite.id,
                name: favorite.name || null,
                imageUrl: imageUrl
              };
            }
          }
        } catch (error) {
          // Continue to next household
          continue;
        }
      }
    } catch (error) {
      // Silent - non-fatal
    }

    return null;
  } catch (error) {
    console.warn('[SonosData] Failed to find favorite by container ID:', {
      containerId,
      error: error.message
    });
    return null;
  }
}

async function getHouseholdSnapshot(householdId, deviceId) {
  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 401 });
  }
  const response = await sonosRequest(`/households/${encodeURIComponent(householdId)}/groups`, { deviceId });
  return response.json();
}

async function findGroupContext(groupId, householdHint, deviceId) {
  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 401 });
  }
  const normalizedGroupId = groupId;
  const households = await listHouseholds(deviceId);
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
      const snapshot = await getHouseholdSnapshot(householdId, deviceId);
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

async function autogroupGroupMembers(groupId, householdHint, deviceId) {
  if (!deviceId) {
    return { success: false, error: 'device_id_required' };
  }
  try {
    const context = await findGroupContext(groupId, householdHint, deviceId);
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
      body: JSON.stringify({ playerIds }),
      deviceId
    });

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const current = await getHouseholdSnapshot(householdId, deviceId);
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

async function applyDefaultVolumes(householdId, deviceId) {
  if (!householdId || !deviceId) {
    return;
  }

  try {
    // Reload volumes from database to ensure we have the latest values
    const volumes = await loadSpeakerVolumes();
    // Update cache to keep it in sync
    speakerVolumes = volumes;

    const response = await sonosFetch(`/households/${encodeURIComponent(householdId)}/groups`, { deviceId });
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const players = Array.isArray(payload.players) ? payload.players : [];

    const jobs = players
      .map((player) => {
        const target = volumes[player?.id];
        if (typeof target === 'number' && Number.isFinite(target)) {
          return sonosFetch(`/players/${encodeURIComponent(player.id)}/playerVolume`, {
            method: 'POST',
            body: JSON.stringify({ volume: target }),
            deviceId
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

async function clearGroupQueue(groupId, deviceId) {
  if (!deviceId) {
    return { success: false, supported: false, error: 'Device ID is required' };
  }
  const encodedGroupId = encodeURIComponent(groupId);
  const collectedIds = [];
  let supported = false;
  let lastError;

  try {
    let offset = 0;
    const pageSize = 200;

    while (true) {
      const response = await sonosRequest(
        `/groups/${encodedGroupId}/playback/queue/items?quantity=${pageSize}&offset=${offset}`,
        { deviceId }
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
        body: JSON.stringify({ itemIds: chunk }),
        deviceId
      });
    }

    return { success: true, supported: true };
  } catch (error) {
    lastError = error.message || error.toString();
    return { success: false, supported: true, error: lastError };
  }
}

async function exchangeCodeForTokens(code, deviceId) {
  console.error('[AUTH_DEBUG] exchangeCodeForTokens called', { 
    deviceId, 
    hasDeviceId: !!deviceId,
    codeLength: code?.length || 0,
    hasCode: !!code
  });

  if (!deviceId) {
    console.error('[AUTH_DEBUG] exchangeCodeForTokens: ERROR - No deviceId provided');
    throw new Error('Device ID is required');
  }

  if (!code) {
    console.error('[AUTH_DEBUG] exchangeCodeForTokens: ERROR - No code provided');
    throw new Error('Authorization code is required');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI
  });

  console.error('[AUTH_DEBUG] exchangeCodeForTokens: Requesting tokens from Sonos', {
    deviceId,
    grantType: 'authorization_code',
    redirectUri: REDIRECT_URI,
    codeLength: code.length
  });

  const response = await fetch(`${SONOS_AUTH_BASE}/login/v3/oauth/access`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SONOS_CLIENT_ID}:${SONOS_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  console.error('[AUTH_DEBUG] exchangeCodeForTokens: Sonos API response received', {
    deviceId,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[AUTH_DEBUG] exchangeCodeForTokens: Sonos API error', {
      deviceId,
      status: response.status,
      errorText: text
    });
    throw new Error(`OAuth token exchange failed: ${text}`);
  }

  const payload = await response.json();
  console.error('[AUTH_DEBUG] exchangeCodeForTokens: Token payload received from Sonos', {
    deviceId,
    hasAccessToken: !!payload.access_token,
    hasRefreshToken: !!payload.refresh_token,
    expiresIn: payload.expires_in,
    tokenType: payload.token_type,
    accessTokenLength: payload.access_token?.length || 0,
    refreshTokenLength: payload.refresh_token?.length || 0
  });

  const tokenData = storeTokens(payload);
  console.error('[AUTH_DEBUG] exchangeCodeForTokens: Token data processed', {
    deviceId,
    hasAccessToken: !!tokenData.access_token,
    hasRefreshToken: !!tokenData.refresh_token,
    expiresAt: tokenData.expires_at,
    expiresAtDate: new Date(tokenData.expires_at).toISOString()
  });

  console.error('[AUTH_DEBUG] exchangeCodeForTokens: Saving tokens to database', { deviceId });
  await saveTokens(tokenData, deviceId);
  console.error('[AUTH_DEBUG] exchangeCodeForTokens: Tokens saved to database successfully', { deviceId });
}

function storeTokens(tokenResponse) {
  const tokenData = {
    access_token: tokenResponse.access_token ?? null,
    refresh_token: tokenResponse.refresh_token ?? null,
    expires_at: 0
  };
  const expiresIn = Number(tokenResponse.expires_in ?? 0);
  const bufferMs = 60 * 1000;
  tokenData.expires_at = Date.now() + Math.max(expiresIn * 1000 - bufferMs, bufferMs);
  return tokenData;
}

async function refreshAccessToken(deviceId) {
  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 401 });
  }

  const deviceTokens = await loadTokens(deviceId);
  if (!deviceTokens.refresh_token) {
    throw Object.assign(new Error('Missing refresh token'), { status: 401 });
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: deviceTokens.refresh_token
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
    await clearTokens(deviceId);
    const text = await response.text();
    throw Object.assign(new Error(`Token refresh failed: ${text}`), { status: response.status });
  }

  const payload = await response.json();
  const tokenData = storeTokens(payload);
  await saveTokens(tokenData, deviceId);
  return tokenData;
}

async function ensureValidAccessToken(deviceId) {
  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 401 });
  }

  // Ensure other data stores are initialized
  await ensureInitialized();
  
  // Load tokens for this device
  const deviceTokens = await loadTokens(deviceId);
  
  if (!deviceTokens || !deviceTokens.access_token) {
    throw Object.assign(new Error('Not authenticated with Sonos'), { status: 401 });
  }

  if (Date.now() >= deviceTokens.expires_at) {
    const refreshedTokens = await refreshAccessToken(deviceId);
    // Update the tokens variable for this request
    tokens = refreshedTokens;
  } else {
    tokens = deviceTokens;
  }
}

async function sonosFetch(endpoint, options = {}) {
  const deviceId = options.deviceId;
  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 401 });
  }

  await ensureValidAccessToken(deviceId);

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
    await refreshAccessToken(deviceId);
    requestOptions.headers.Authorization = `Bearer ${tokens.access_token}`;
    response = await fetch(`${SONOS_CONTROL_BASE}${endpoint}`, requestOptions);
  }

  if (response.status === 401) {
    await clearTokens(deviceId);
  }

  return response;
}

async function sonosRequest(endpoint, options = {}) {
  // Handle case where deviceId is passed as second parameter (backward compatibility)
  let deviceId;
  if (typeof options === 'string') {
    deviceId = options;
    options = {};
  } else {
    deviceId = options.deviceId;
  }

  if (!deviceId) {
    throw Object.assign(new Error('Device ID is required'), { status: 401 });
  }

  await ensureValidAccessToken(deviceId);

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
    await refreshAccessToken(deviceId);
    requestOptions.headers.Authorization = `Bearer ${tokens.access_token}`;
    response = await fetch(`${SONOS_CONTROL_BASE}${endpoint}`, requestOptions);
    if (response.status === 401) {
      await clearTokens(deviceId);
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
    // Removed console.log for server listening message
  });
}
