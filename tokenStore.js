import { supabase } from './supabase.js';

export async function loadTokens() {
  try {
    const { data, error } = await supabase
      .from('tokens')
      .select('access_token, refresh_token, expires_at')
      .eq('id', 1)
      .single();

    if (error) {
      // If row doesn't exist (PGRST116) or no rows found, return empty tokens
      if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
        return { access_token: null, refresh_token: null, expires_at: 0 };
      }
      // For other errors, log and return empty tokens (don't throw to prevent app crash)
      console.error('Error loading tokens from Supabase:', error);
      return { access_token: null, refresh_token: null, expires_at: 0 };
    }

    return {
      access_token: data?.access_token || null,
      refresh_token: data?.refresh_token || null,
      expires_at: Number(data?.expires_at || 0)
    };
  } catch (error) {
    console.error('Error loading tokens:', error);
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }
}

export async function saveTokens(tokens) {
  try {
    const toSave = {
      id: 1,
      access_token: tokens.access_token || null,
      refresh_token: tokens.refresh_token || null,
      expires_at: Number(tokens.expires_at || 0)
    };

    const { error } = await supabase
      .from('tokens')
      .upsert(toSave, { onConflict: 'id' });

    if (error) {
      throw error;
    }

    return toSave;
  } catch (error) {
    console.error('Error saving tokens:', error);
    throw error;
  }
}

export async function clearTokens() {
  try {
    const { error } = await supabase
      .from('tokens')
      .update({
        access_token: null,
        refresh_token: null,
        expires_at: 0
      })
      .eq('id', 1);

    if (error) {
      throw error;
    }

    return { access_token: null, refresh_token: null, expires_at: 0 };
  } catch (error) {
    console.error('Error clearing tokens:', error);
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }
}
