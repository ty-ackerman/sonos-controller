import { supabase } from './supabase.js';

const VALID_VIBES = ['Down', 'Down/Mid', 'Mid'];

export async function loadVibeTimeRules() {
  try {
    const { data, error } = await supabase
      .from('vibe_time_rules')
      .select('id, start_hour, end_hour, allowed_vibes, days, rule_type, created_at, updated_at')
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
        row.allowed_vibes.length > 0 &&
        (row.rule_type === 'base' || row.rule_type === 'override')
      ) {
        // Validate that all vibes in the array are valid
        const validVibes = row.allowed_vibes.filter((vibe) =>
          typeof vibe === 'string' && VALID_VIBES.includes(vibe)
        );
        if (validVibes.length > 0) {
          // Validate days array based on rule_type
          let validDays = null;
          if (row.rule_type === 'override') {
            // Override rules must have exactly one day
            if (row.days !== null && row.days !== undefined && Array.isArray(row.days)) {
              const filteredDays = row.days.filter(
                (day) => typeof day === 'number' && day >= 0 && day <= 6
              );
              // Remove duplicates
              validDays = [...new Set(filteredDays)].sort();
              if (validDays.length === 0) {
                // Invalid: override must have at least one day
                return;
              }
            } else {
              // Invalid: override must have days array
              return;
            }
          } else {
            // Base rules must have days = null
            if (row.days !== null && row.days !== undefined) {
              // Invalid: base rules should not have days
              return;
            }
            validDays = null;
          }

          sanitized.push({
            id: row.id,
            start_hour: row.start_hour,
            end_hour: row.end_hour,
            allowed_vibes: validVibes,
            days: validDays,
            rule_type: row.rule_type
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

// Helper function to check if two time ranges overlap
function timeRangesOverlap(start1, end1, start2, end2) {
  // Handle normal ranges
  if (start1 <= end1 && start2 <= end2) {
    return !(end1 < start2 || end2 < start1);
  }
  // Handle wraparound ranges (e.g., 22-6)
  // For simplicity, we'll check if either range contains the other's start or end
  if (start1 > end1) {
    // First range wraps around
    return timeRangesOverlap(0, end1, start2, end2) || timeRangesOverlap(start1, 23, start2, end2);
  }
  if (start2 > end2) {
    // Second range wraps around
    return timeRangesOverlap(start1, end1, 0, end2) || timeRangesOverlap(start1, end1, start2, 23);
  }
  return false;
}

// Validate that override rules don't overlap with existing overrides for the same day
async function validateOverrideOverlap(rule) {
  if (rule.rule_type !== 'override') {
    return; // Only validate overrides
  }

  if (!rule.days || !Array.isArray(rule.days) || rule.days.length === 0) {
    throw new Error('Override rules must specify exactly one day');
  }

  if (rule.days.length !== 1) {
    throw new Error('Override rules must specify exactly one day');
  }

  const overrideDay = rule.days[0];

  // Load all existing override rules for the same day
  const { data, error } = await supabase
    .from('vibe_time_rules')
    .select('id, start_hour, end_hour, days')
    .eq('rule_type', 'override');

  if (error) {
    throw new Error('Failed to validate override overlap');
  }

  // Check for overlaps with existing overrides for the same day
  const existingOverrides = (data || []).filter((existing) => {
    // Skip the rule being updated (if updating)
    if (rule.id && existing.id === rule.id) {
      return false;
    }
    // Check if it's for the same day
    if (!existing.days || !Array.isArray(existing.days) || existing.days.length !== 1) {
      return false;
    }
    return existing.days[0] === overrideDay;
  });

  // Check for time overlaps
  for (const existing of existingOverrides) {
    if (timeRangesOverlap(rule.start_hour, rule.end_hour, existing.start_hour, existing.end_hour)) {
      throw new Error(`This override overlaps with an existing override for the same day. Please adjust the time range.`);
    }
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

    // Validate rule_type
    const ruleType = rule.rule_type || 'base';
    if (ruleType !== 'base' && ruleType !== 'override') {
      throw new Error('rule_type must be either "base" or "override"');
    }

    // Validate vibes
    const validVibes = rule.allowed_vibes.filter(
      (vibe) => typeof vibe === 'string' && VALID_VIBES.includes(vibe)
    );
    if (validVibes.length === 0) {
      throw new Error('At least one valid vibe is required');
    }

    // Validate and sanitize days based on rule_type
    let days = null;
    if (ruleType === 'override') {
      // Override rules must have exactly one day
      if (rule.days === null || rule.days === undefined || !Array.isArray(rule.days) || rule.days.length === 0) {
        throw new Error('Override rules must specify exactly one day');
      }
      const validDays = rule.days.filter(
        (day) => typeof day === 'number' && day >= 0 && day <= 6
      );
      // Remove duplicates and sort
      days = [...new Set(validDays)].sort();
      if (days.length !== 1) {
        throw new Error('Override rules must specify exactly one day');
      }
    } else {
      // Base rules must have days = null
      if (rule.days !== null && rule.days !== undefined) {
        throw new Error('Base schedule rules cannot specify days');
      }
      days = null;
    }

    // Validate override overlaps before saving
    await validateOverrideOverlap({
      ...rule,
      rule_type: ruleType,
      days: days
    });

    const row = {
      start_hour: rule.start_hour,
      end_hour: rule.end_hour,
      allowed_vibes: validVibes,
      days: days,
      rule_type: ruleType
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
        allowed_vibes: data.allowed_vibes,
        days: data.days,
        rule_type: data.rule_type
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
        allowed_vibes: data.allowed_vibes,
        days: data.days,
        rule_type: data.rule_type
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

