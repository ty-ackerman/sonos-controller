import { supabase } from './supabase.js';

const VALID_VIBES = ['Down', 'Down/Mid', 'Mid'];

export async function loadPlaylistVibes() {
  try {
    const { data, error } = await supabase
      .from('playlist_vibes')
      .select('playlist_id, vibe');

    if (error) {
      console.error('Error loading playlist vibes:', error);
      return {};
    }

    const sanitized = {};
    (data || []).forEach((row) => {
      if (row.playlist_id && typeof row.vibe === 'string' && VALID_VIBES.includes(row.vibe)) {
        sanitized[row.playlist_id] = row.vibe;
      }
    });

    return sanitized;
  } catch (error) {
    console.error('Error loading playlist vibes:', error);
    return {};
  }
}

export async function savePlaylistVibes(map) {
  try {
    const sanitized = {};
    const rows = [];

    Object.entries(map || {}).forEach(([playlistId, vibe]) => {
      if (typeof playlistId === 'string' && typeof vibe === 'string' && VALID_VIBES.includes(vibe)) {
        sanitized[playlistId] = vibe;
        rows.push({
          playlist_id: playlistId,
          vibe: vibe
        });
      }
    });

    if (rows.length === 0) {
      return sanitized;
    }

    // Upsert all playlist vibes
    const { error } = await supabase
      .from('playlist_vibes')
      .upsert(rows, { onConflict: 'playlist_id' });

    if (error) {
      throw error;
    }

    return sanitized;
  } catch (error) {
    console.error('Error saving playlist vibes:', error);
    throw error;
  }
}

export function getValidVibes() {
  return [...VALID_VIBES];
}

