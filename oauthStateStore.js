import { supabase } from './supabase.js';

export async function saveOAuthState(state, deviceId) {
  try {
    const { error } = await supabase
      .from('oauth_states')
      .upsert({
        state,
        device_id: deviceId,
        created_at: new Date().toISOString()
      }, { onConflict: 'state' });

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('Error saving OAuth state:', error);
    throw error;
  }
}

export async function getOAuthStateDeviceId(state) {
  try {
    const { data, error } = await supabase
      .from('oauth_states')
      .select('device_id')
      .eq('state', state)
      .single();

    if (error) {
      if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
        return null;
      }
      throw error;
    }

    return data?.device_id || null;
  } catch (error) {
    console.error('Error getting OAuth state device ID:', error);
    return null;
  }
}

export async function deleteOAuthState(state) {
  try {
    const { error } = await supabase
      .from('oauth_states')
      .delete()
      .eq('state', state);

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('Error deleting OAuth state:', error);
    // Don't throw - cleanup is best effort
  }
}

