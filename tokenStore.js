import { supabase } from './supabase.js';

export async function loadTokens(deviceId) {
  console.error('[AUTH_DEBUG] loadTokens called', { deviceId, hasDeviceId: !!deviceId });
  
  if (!deviceId) {
    console.error('[AUTH_DEBUG] loadTokens: No deviceId provided, returning empty tokens');
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }

  try {
    console.error('[AUTH_DEBUG] loadTokens: Querying Supabase for device_id:', deviceId);
    const { data, error } = await supabase
      .from('tokens')
      .select('access_token, refresh_token, expires_at')
      .eq('device_id', deviceId)
      .single();

    if (error) {
      // If row doesn't exist (PGRST116) or no rows found, return empty tokens
      if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
        console.error('[AUTH_DEBUG] loadTokens: No tokens found for device_id:', deviceId, { errorCode: error.code });
        return { access_token: null, refresh_token: null, expires_at: 0 };
      }
      // For other errors, log and return empty tokens (don't throw to prevent app crash)
      console.error('[AUTH_DEBUG] loadTokens: Error loading tokens from Supabase:', { deviceId, error: error.message, errorCode: error.code, errorDetails: error });
      return { access_token: null, refresh_token: null, expires_at: 0 };
    }

    const hasAccessToken = !!data?.access_token;
    const hasRefreshToken = !!data?.refresh_token;
    const expiresAt = Number(data?.expires_at || 0);
    const isExpired = Date.now() >= expiresAt;
    
    console.error('[AUTH_DEBUG] loadTokens: Success', { 
      deviceId, 
      hasAccessToken, 
      hasRefreshToken, 
      expiresAt, 
      expiresAtDate: expiresAt ? new Date(expiresAt).toISOString() : null,
      isExpired,
      now: Date.now(),
      nowDate: new Date().toISOString()
    });

    return {
      access_token: data?.access_token || null,
      refresh_token: data?.refresh_token || null,
      expires_at: expiresAt
    };
  } catch (error) {
    console.error('[AUTH_DEBUG] loadTokens: Exception caught:', { deviceId, error: error.message, stack: error.stack });
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }
}

export async function saveTokens(tokens, deviceId) {
  console.error('[AUTH_DEBUG] saveTokens called', { 
    deviceId, 
    hasDeviceId: !!deviceId,
    hasAccessToken: !!tokens?.access_token,
    hasRefreshToken: !!tokens?.refresh_token,
    expiresAt: tokens?.expires_at,
    expiresAtDate: tokens?.expires_at ? new Date(Number(tokens.expires_at)).toISOString() : null
  });

  if (!deviceId) {
    console.error('[AUTH_DEBUG] saveTokens: ERROR - Device ID is required');
    throw new Error('Device ID is required to save tokens');
  }

  try {
    const toSave = {
      device_id: deviceId,
      access_token: tokens.access_token || null,
      refresh_token: tokens.refresh_token || null,
      expires_at: Number(tokens.expires_at || 0)
    };

    console.error('[AUTH_DEBUG] saveTokens: Preparing to upsert to Supabase', {
      device_id: toSave.device_id,
      hasAccessToken: !!toSave.access_token,
      hasRefreshToken: !!toSave.refresh_token,
      expires_at: toSave.expires_at,
      expiresAtDate: toSave.expires_at ? new Date(toSave.expires_at).toISOString() : null,
      accessTokenLength: toSave.access_token?.length || 0,
      refreshTokenLength: toSave.refresh_token?.length || 0
    });

    const { data, error } = await supabase
      .from('tokens')
      .upsert(toSave, { onConflict: 'device_id' })
      .select();

    if (error) {
      console.error('[AUTH_DEBUG] saveTokens: Supabase upsert ERROR', {
        deviceId,
        error: error.message,
        errorCode: error.code,
        errorDetails: error,
        toSave
      });
      throw error;
    }

    console.error('[AUTH_DEBUG] saveTokens: Supabase upsert SUCCESS', {
      deviceId,
      returnedData: data,
      upsertedDeviceId: data?.[0]?.device_id,
      hasAccessToken: !!data?.[0]?.access_token,
      hasRefreshToken: !!data?.[0]?.refresh_token,
      expiresAt: data?.[0]?.expires_at
    });

    // Verify the write by reading it back
    const { data: verifyData, error: verifyError } = await supabase
      .from('tokens')
      .select('device_id, access_token, refresh_token, expires_at')
      .eq('device_id', deviceId)
      .single();

    if (verifyError) {
      console.error('[AUTH_DEBUG] saveTokens: Verification read FAILED', {
        deviceId,
        verifyError: verifyError.message,
        verifyErrorCode: verifyError.code
      });
    } else {
      console.error('[AUTH_DEBUG] saveTokens: Verification read SUCCESS', {
        deviceId,
        verifiedDeviceId: verifyData?.device_id,
        verifiedHasAccessToken: !!verifyData?.access_token,
        verifiedHasRefreshToken: !!verifyData?.refresh_token,
        verifiedExpiresAt: verifyData?.expires_at
      });
    }

    // Also list ALL tokens in the database to verify device-specific storage
    const { data: allTokens, error: allTokensError } = await supabase
      .from('tokens')
      .select('device_id, access_token, refresh_token, expires_at')
      .not('device_id', 'is', null);

    if (allTokensError) {
      console.error('[AUTH_DEBUG] saveTokens: Failed to list all tokens', {
        deviceId,
        allTokensError: allTokensError.message
      });
    } else {
      console.error('[AUTH_DEBUG] saveTokens: All tokens in database', {
        deviceId,
        totalTokens: allTokens?.length || 0,
        allDeviceIds: allTokens?.map(t => t.device_id) || [],
        tokenCounts: allTokens?.map(t => ({
          device_id: t.device_id,
          hasAccessToken: !!t.access_token,
          hasRefreshToken: !!t.refresh_token
        })) || []
      });
    }

    return toSave;
  } catch (error) {
    console.error('[AUTH_DEBUG] saveTokens: Exception caught', {
      deviceId,
      error: error.message,
      errorStack: error.stack,
      errorDetails: error
    });
    throw error;
  }
}

export async function clearTokens(deviceId) {
  console.error('[AUTH_DEBUG] clearTokens called', { deviceId, hasDeviceId: !!deviceId });
  
  if (!deviceId) {
    console.error('[AUTH_DEBUG] clearTokens: No deviceId provided');
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }

  try {
    console.error('[AUTH_DEBUG] clearTokens: Updating Supabase to clear tokens for device_id:', deviceId);
    const { data, error } = await supabase
      .from('tokens')
      .update({
        access_token: null,
        refresh_token: null,
        expires_at: 0
      })
      .eq('device_id', deviceId)
      .select();

    if (error) {
      console.error('[AUTH_DEBUG] clearTokens: Supabase update ERROR', {
        deviceId,
        error: error.message,
        errorCode: error.code,
        errorDetails: error
      });
      throw error;
    }

    console.error('[AUTH_DEBUG] clearTokens: Supabase update SUCCESS', {
      deviceId,
      updatedRows: data?.length || 0,
      updatedData: data,
      updatedDeviceIds: data?.map(d => d.device_id) || []
    });

    // Verify only this device's tokens were cleared by listing all tokens
    const { data: allTokensAfter, error: allTokensError } = await supabase
      .from('tokens')
      .select('device_id, access_token, refresh_token, expires_at')
      .not('device_id', 'is', null);

    if (allTokensError) {
      console.error('[AUTH_DEBUG] clearTokens: Failed to list all tokens after clear', {
        deviceId,
        allTokensError: allTokensError.message
      });
    } else {
      console.error('[AUTH_DEBUG] clearTokens: All tokens in database after clear', {
        deviceId,
        totalTokens: allTokensAfter?.length || 0,
        allDeviceIds: allTokensAfter?.map(t => t.device_id) || [],
        clearedDeviceStillHasTokens: allTokensAfter?.some(t => t.device_id === deviceId && (t.access_token || t.refresh_token))
      });
    }

    return { access_token: null, refresh_token: null, expires_at: 0 };
  } catch (error) {
    console.error('[AUTH_DEBUG] clearTokens: Exception caught', {
      deviceId,
      error: error.message,
      errorStack: error.stack
    });
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }
}
