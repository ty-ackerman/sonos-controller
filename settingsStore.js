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

export async function deleteSpeakerVolumes(playerIds) {
  try {
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return;
    }

    const { error } = await supabase
      .from('speaker_volumes')
      .delete()
      .in('player_id', playerIds);

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('Error deleting speaker volumes:', error);
    throw error;
  }
}

export async function saveSpeakerVolumes(map) {
  try {
    const sanitized = {};
    const rows = [];
    const toDelete = [];

    Object.entries(map || {}).forEach(([playerId, value]) => {
      // Handle null/undefined/empty string as deletion
      if (value === null || value === undefined || value === '') {
        toDelete.push(playerId);
        return;
      }

      const numeric = Number(value);
      if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
        const normalized = Math.max(0, Math.min(100, numeric));
        sanitized[playerId] = normalized;
        rows.push({
          player_id: playerId,
          volume: normalized
        });
      }
    });

    // Delete volumes that were cleared
    if (toDelete.length > 0) {
      await deleteSpeakerVolumes(toDelete);
    }

    // Upsert remaining volumes
    if (rows.length > 0) {
      const { error } = await supabase
        .from('speaker_volumes')
        .upsert(rows, { onConflict: 'player_id' });

      if (error) {
        throw error;
      }
    }

    return sanitized;
  } catch (error) {
    console.error('Error saving speaker volumes:', error);
    throw error;
  }
}

