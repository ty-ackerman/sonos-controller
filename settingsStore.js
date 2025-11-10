import { supabase } from './supabase.js';

export async function loadSpeakerVolumes() {
  try {
    const { data, error } = await supabase
      .from('speaker_volumes')
      .select('player_id, volume');

    if (error) {
      console.error('Error loading speaker volumes:', error);
      return {};
    }

    const sanitized = {};
    (data || []).forEach((row) => {
      if (row.player_id) {
        const value = Number(row.volume);
        const normalized = Number.isFinite(value) ? value : 0;
        sanitized[row.player_id] = Math.max(0, Math.min(100, normalized));
      }
    });

    return sanitized;
  } catch (error) {
    console.error('Error loading speaker volumes:', error);
    return {};
  }
}

export async function saveSpeakerVolumes(map) {
  try {
    const sanitized = {};
    const rows = [];

    Object.entries(map || {}).forEach(([playerId, value]) => {
      const numeric = Number(value);
      const normalized = Number.isFinite(numeric) ? numeric : 0;
      const volume = Math.max(0, Math.min(100, normalized));
      sanitized[playerId] = volume;
      rows.push({
        player_id: playerId,
        volume: volume
      });
    });

    if (rows.length === 0) {
      return sanitized;
    }

    // Upsert all volumes
    const { error } = await supabase
      .from('speaker_volumes')
      .upsert(rows, { onConflict: 'player_id' });

    if (error) {
      throw error;
    }

    return sanitized;
  } catch (error) {
    console.error('Error saving speaker volumes:', error);
    throw error;
  }
}

