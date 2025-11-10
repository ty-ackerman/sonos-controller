import { supabase } from './supabase.js';

const VALID_VIBES = ['Down', 'Down/Mid', 'Mid'];

export async function loadVibeTimeRules() {
  try {
    const { data, error } = await supabase
      .from('vibe_time_rules')
      .select('id, start_hour, end_hour, allowed_vibes, created_at, updated_at')
      .order('start_hour', { ascending: true });

    if (error) {
      console.error('Error loading vibe time rules:', error);
      return [];
    }

    const sanitized = [];
    (data || []).forEach((row) => {
      if (
        typeof row.id === 'number' &&
        typeof row.start_hour === 'number' &&
        row.start_hour >= 0 &&
        row.start_hour <= 23 &&
        typeof row.end_hour === 'number' &&
        row.end_hour >= 0 &&
        row.end_hour <= 23 &&
        Array.isArray(row.allowed_vibes) &&
        row.allowed_vibes.length > 0
      ) {
        // Validate that all vibes in the array are valid
        const validVibes = row.allowed_vibes.filter((vibe) =>
          typeof vibe === 'string' && VALID_VIBES.includes(vibe)
        );
        if (validVibes.length > 0) {
          sanitized.push({
            id: row.id,
            start_hour: row.start_hour,
            end_hour: row.end_hour,
            allowed_vibes: validVibes
          });
        }
      }
    });

    return sanitized;
  } catch (error) {
    console.error('Error loading vibe time rules:', error);
    return [];
  }
}

export async function saveVibeTimeRule(rule) {
  try {
    if (!rule || typeof rule.start_hour !== 'number' || typeof rule.end_hour !== 'number') {
      throw new Error('Invalid rule data');
    }

    if (rule.start_hour < 0 || rule.start_hour > 23 || rule.end_hour < 0 || rule.end_hour > 23) {
      throw new Error('Hours must be between 0 and 23');
    }

    if (!Array.isArray(rule.allowed_vibes) || rule.allowed_vibes.length === 0) {
      throw new Error('At least one allowed vibe is required');
    }

    // Validate vibes
    const validVibes = rule.allowed_vibes.filter(
      (vibe) => typeof vibe === 'string' && VALID_VIBES.includes(vibe)
    );
    if (validVibes.length === 0) {
      throw new Error('At least one valid vibe is required');
    }

    const row = {
      start_hour: rule.start_hour,
      end_hour: rule.end_hour,
      allowed_vibes: validVibes
    };

    if (rule.id) {
      // Update existing rule
      const { data, error } = await supabase
        .from('vibe_time_rules')
        .update(row)
        .eq('id', rule.id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return {
        id: data.id,
        start_hour: data.start_hour,
        end_hour: data.end_hour,
        allowed_vibes: data.allowed_vibes
      };
    } else {
      // Create new rule
      const { data, error } = await supabase
        .from('vibe_time_rules')
        .insert(row)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return {
        id: data.id,
        start_hour: data.start_hour,
        end_hour: data.end_hour,
        allowed_vibes: data.allowed_vibes
      };
    }
  } catch (error) {
    console.error('Error saving vibe time rule:', error);
    throw error;
  }
}

export async function deleteVibeTimeRule(id) {
  try {
    if (!id || typeof id !== 'number') {
      throw new Error('Invalid rule ID');
    }

    const { error } = await supabase.from('vibe_time_rules').delete().eq('id', id);

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('Error deleting vibe time rule:', error);
    throw error;
  }
}

export function getValidVibes() {
  return [...VALID_VIBES];
}

