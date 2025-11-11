import { supabase } from './supabase.js';

export async function loadHiddenFavorites() {
  try {
    const { data, error } = await supabase
      .from('hidden_favorites')
      .select('favorite_id');

    if (error) {
      console.error('Error loading hidden favorites:', error);
      return new Set();
    }

    const hiddenSet = new Set();
    (data || []).forEach((row) => {
      if (row.favorite_id && typeof row.favorite_id === 'string') {
        hiddenSet.add(row.favorite_id);
      }
    });

    return hiddenSet;
  } catch (error) {
    console.error('Error loading hidden favorites:', error);
    return new Set();
  }
}

export async function setFavoriteHidden(favoriteId, hidden) {
  try {
    if (!favoriteId || typeof favoriteId !== 'string') {
      throw new Error('Invalid favorite ID');
    }

    if (hidden) {
      // Add to hidden favorites
      const { error } = await supabase
        .from('hidden_favorites')
        .upsert(
          { favorite_id: favoriteId },
          { onConflict: 'favorite_id' }
        );

      if (error) {
        throw error;
      }
    } else {
      // Remove from hidden favorites
      const { error } = await supabase
        .from('hidden_favorites')
        .delete()
        .eq('favorite_id', favoriteId);

      if (error) {
        throw error;
      }
    }

    return true;
  } catch (error) {
    console.error('Error setting favorite hidden state:', error);
    throw error;
  }
}

export async function isFavoriteHidden(favoriteId) {
  try {
    const { data, error } = await supabase
      .from('hidden_favorites')
      .select('favorite_id')
      .eq('favorite_id', favoriteId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No row found, favorite is not hidden
        return false;
      }
      throw error;
    }

    return !!data;
  } catch (error) {
    console.error('Error checking if favorite is hidden:', error);
    return false;
  }
}

