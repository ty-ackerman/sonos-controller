import { supabase } from './supabase.js';

export async function loadTokens(deviceId) {
  if (!deviceId) {
    console.error('Device ID is required to load tokens');
    return { access_token: null, refresh_token: null, expires_at: 0, created_at: null };
  }

  try {
    const { data, error } = await supabase
      .from('tokens')
      .select('access_token, refresh_token, expires_at, created_at')
      .eq('device_id', deviceId)
      .single();

    if (error) {
      // If row doesn't exist (PGRST116) or no rows found, return empty tokens
      if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
        return { access_token: null, refresh_token: null, expires_at: 0, created_at: null };
      }
      // For other errors, log and return empty tokens (don't throw to prevent app crash)
      console.error('Error loading tokens from Supabase:', error);
      return { access_token: null, refresh_token: null, expires_at: 0, created_at: null };
    }

    return {
      access_token: data?.access_token || null,
      refresh_token: data?.refresh_token || null,
      expires_at: Number(data?.expires_at || 0),
      created_at: data?.created_at || null
    };
  } catch (error) {
    console.error('Error loading tokens:', error);
    return { access_token: null, refresh_token: null, expires_at: 0, created_at: null };
  }
}

export async function saveTokens(tokens, deviceId) {
  if (!deviceId) {
    throw new Error('Device ID is required to save tokens');
  }

  try {
    const toSave = {
      device_id: deviceId,
      access_token: tokens.access_token || null,
      refresh_token: tokens.refresh_token || null,
      expires_at: Number(tokens.expires_at || 0)
    };

    const { error } = await supabase
      .from('tokens')
      .upsert(toSave, { onConflict: 'device_id' });

    if (error) {
      throw error;
    }

    return toSave;
  } catch (error) {
    console.error('Error saving tokens:', error);
    throw error;
  }
}

export async function clearTokens(deviceId) {
  if (!deviceId) {
    console.error('Device ID is required to clear tokens');
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }

  try {
    const { error } = await supabase
      .from('tokens')
      .update({
        access_token: null,
        refresh_token: null,
        expires_at: 0
      })
      .eq('device_id', deviceId);

    if (error) {
      throw error;
    }

    return { access_token: null, refresh_token: null, expires_at: 0 };
  } catch (error) {
    console.error('Error clearing tokens:', error);
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }
}

export async function getAllActiveTokens() {
  try {
    const { data, error } = await supabase
      .from('tokens')
      .select('device_id, access_token, refresh_token, expires_at, created_at')
      .not('refresh_token', 'is', null);

    if (error) {
      console.error('Error loading all active tokens from Supabase:', error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    return data.map(row => ({
      device_id: row.device_id,
      access_token: row.access_token || null,
      refresh_token: row.refresh_token || null,
      expires_at: Number(row.expires_at || 0),
      created_at: row.created_at || null
    }));
  } catch (error) {
    console.error('Error loading all active tokens:', error);
    return [];
  }
}
