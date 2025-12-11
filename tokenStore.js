import { supabase } from './supabase.js';

export async function loadTokens(deviceId) {
  const timestamp = new Date().toISOString();
  const requestId = Math.random().toString(36).substring(7);
  
  if (!deviceId) {
    console.error(`[AUTH DEBUG ${timestamp}] [${requestId}] Device ID is required to load tokens`);
    return { access_token: null, refresh_token: null, expires_at: 0, created_at: null };
  }

  console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] loadTokens called for deviceId:`, deviceId.substring(0, 8) + '...');

  try {
    const { data, error } = await supabase
      .from('tokens')
      .select('access_token, refresh_token, expires_at, created_at, updated_at')
      .eq('device_id', deviceId)
      .single();

    console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] Supabase query result:`, {
      hasData: !!data,
      hasError: !!error,
      errorCode: error?.code,
      errorMessage: error?.message
    });

    if (error) {
      // If row doesn't exist (PGRST116) or no rows found, return empty tokens
      if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
        console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] No tokens found in database (row doesn't exist)`);
        return { access_token: null, refresh_token: null, expires_at: 0, created_at: null, updated_at: null };
      }
      // For other errors, log and return empty tokens (don't throw to prevent app crash)
      console.error(`[AUTH DEBUG ${timestamp}] [${requestId}] Error loading tokens from Supabase:`, error);
      return { access_token: null, refresh_token: null, expires_at: 0, created_at: null, updated_at: null };
    }

    const result = {
      access_token: data?.access_token || null,
      refresh_token: data?.refresh_token || null,
      expires_at: Number(data?.expires_at || 0),
      created_at: data?.created_at || null,
      updated_at: data?.updated_at || null
    };
    
    console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] Tokens loaded successfully:`, {
      hasAccessToken: !!result.access_token,
      hasRefreshToken: !!result.refresh_token,
      expiresAt: result.expires_at,
      created_at: result.created_at,
      updated_at: result.updated_at
    });
    
    return result;
  } catch (error) {
    console.error(`[AUTH DEBUG ${timestamp}] [${requestId}] Error loading tokens:`, error);
    return { access_token: null, refresh_token: null, expires_at: 0, created_at: null, updated_at: null };
  }
}

export async function saveTokens(tokens, deviceId) {
  const timestamp = new Date().toISOString();
  const requestId = Math.random().toString(36).substring(7);
  
  if (!deviceId) {
    throw new Error('Device ID is required to save tokens');
  }

  console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] saveTokens called:`, {
    deviceId: deviceId.substring(0, 8) + '...',
    hasAccessToken: !!tokens.access_token,
    hasRefreshToken: !!tokens.refresh_token,
    expiresAt: tokens.expires_at
  });

  try {
    // Check if tokens already exist for this device
    const existing = await loadTokens(deviceId);
    const hasExistingTokens = !!existing.access_token;
    
    console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] Existing tokens check:`, {
      hasExistingTokens,
      existingCreatedAt: existing.created_at,
      existingCreatedAtDate: existing.created_at ? new Date(existing.created_at).toISOString() : null
    });

    // If old tokens exist and are expired by age, delete them first
    // This ensures created_at gets reset to NOW() when we insert new tokens
    if (hasExistingTokens && existing.created_at) {
      const oldCreatedAt = new Date(existing.created_at).getTime();
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
      const isOldTokenExpired = (Date.now() - oldCreatedAt) >= fourteenDaysMs;
      
      if (isOldTokenExpired) {
        console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] Old token expired by age, deleting before saving new tokens`);
        // Delete the old row so created_at will be set fresh
        const { error: deleteError } = await supabase
          .from('tokens')
          .delete()
          .eq('device_id', deviceId);
        
        if (deleteError) {
          console.error(`[AUTH DEBUG ${timestamp}] [${requestId}] Error deleting old tokens:`, deleteError);
          // Continue anyway - upsert will still work
        } else {
          console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] Old tokens deleted successfully`);
        }
      }
    }

    const toSave = {
      device_id: deviceId,
      access_token: tokens.access_token || null,
      refresh_token: tokens.refresh_token || null,
      expires_at: Number(tokens.expires_at || 0)
      // Don't set created_at - let Supabase set it with DEFAULT NOW()
      // If we deleted old tokens above, this will be a fresh INSERT with new created_at
    };

    console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] Saving to database:`, {
      device_id: toSave.device_id.substring(0, 8) + '...',
      hasAccessToken: !!toSave.access_token,
      hasRefreshToken: !!toSave.refresh_token,
      expires_at: toSave.expires_at
    });

    const { error } = await supabase
      .from('tokens')
      .upsert(toSave, { onConflict: 'device_id' });

    if (error) {
      console.error(`[AUTH DEBUG ${timestamp}] [${requestId}] Error saving tokens:`, error);
      throw error;
    }

    console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] Tokens saved successfully`);
    
    // Verify the save worked by loading back
    const verifyTokens = await loadTokens(deviceId);
    console.log(`[AUTH DEBUG ${timestamp}] [${requestId}] Verification - tokens loaded back:`, {
      hasAccessToken: !!verifyTokens.access_token,
      created_at: verifyTokens.created_at,
      created_atDate: verifyTokens.created_at ? new Date(verifyTokens.created_at).toISOString() : null
    });
    
    return toSave;
  } catch (error) {
    console.error(`[AUTH DEBUG ${timestamp}] [${requestId}] Error saving tokens:`, error);
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
