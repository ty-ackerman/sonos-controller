import { supabase } from './supabase.js';

const VALID_VIBES = ['Down', 'Down/Mid', 'Mid'];

export async function loadVibeTimeRules(householdName) {
  if (!householdName) {
    throw new Error('Household name is required to load vibe time rules');
  }
  try {
    const { data, error } = await supabase
      .from('vibe_time_rules')
      .select('id, name, start_hour, end_hour, allowed_vibes, days, rule_type, created_at, updated_at')
      .eq('household_name', householdName)
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
        // Handle missing rule_type (backward compatibility - default to 'base')
        let ruleType = row.rule_type;
        if (!ruleType || (ruleType !== 'base' && ruleType !== 'override')) {
          console.warn(`[VibeTimeRules] Rule ID ${row.id} missing or invalid rule_type, defaulting to 'base'`);
          ruleType = 'base';
        }
        // Validate that all vibes in the array are valid
        const validVibes = row.allowed_vibes.filter((vibe) =>
          typeof vibe === 'string' && VALID_VIBES.includes(vibe)
        );
        if (validVibes.length > 0) {
          // Validate days array based on rule_type
          let validDays = null;
          if (ruleType === 'override') {
            // Override rules must have at least one day
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
            name: typeof row.name === 'string' ? row.name.trim() : null,
            start_hour: row.start_hour,
            end_hour: row.end_hour,
            allowed_vibes: validVibes,
            days: validDays,
            rule_type: ruleType
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

// Helper function to format hour for display
function formatHour(hour) {
  const h = hour % 12 || 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h}:00 ${ampm}`;
}

// Helper function to check if two time ranges overlap
// Note: end hours are exclusive (e.g., 6-12 means 6:00 AM through 11:59 AM, NOT including 12:00 PM)
function timeRangesOverlap(start1, end1, start2, end2) {
  // Handle normal ranges (both non-wraparound)
  if (start1 <= end1 && start2 <= end2) {
    // Ranges overlap if: start1 < end2 && start2 < end1
    // Since end hours are exclusive, adjacent ranges (e.g., 6-12 and 12-17) don't overlap
    return start1 < end2 && start2 < end1;
  }
  // Handle wraparound ranges (e.g., 22-6)
  if (start1 > end1) {
    // First range wraps around - check both parts
    return timeRangesOverlap(0, end1, start2, end2) || timeRangesOverlap(start1, 23, start2, end2);
  }
  if (start2 > end2) {
    // Second range wraps around - check both parts
    return timeRangesOverlap(start1, end1, 0, end2) || timeRangesOverlap(start1, end1, start2, 23);
  }
  return false;
}

// Validate that base schedule rules don't overlap with existing base rules
async function validateBaseScheduleOverlap(rule, householdName) {
  if (rule.rule_type !== 'base') {
    return; // Only validate base rules
  }

  if (!householdName) {
    throw new Error('Household name is required to validate base schedule overlap');
  }

  // Load all existing base schedule rules for this household
  const { data, error } = await supabase
    .from('vibe_time_rules')
    .select('id, name, start_hour, end_hour')
    .eq('rule_type', 'base')
    .eq('household_name', householdName);

  if (error) {
    throw new Error('Failed to validate base schedule overlap');
  }

  // Check for overlaps with existing base rules
  const existingBaseRules = (data || []).filter((existing) => {
    // Skip the rule being updated (if updating)
    if (rule.id && existing.id === rule.id) {
      return false;
    }
    return true;
  });

  // Check for time overlaps
  for (const existing of existingBaseRules) {
    if (timeRangesOverlap(rule.start_hour, rule.end_hour, existing.start_hour, existing.end_hour)) {
      const existingTimeRange = `${formatHour(existing.start_hour)} - ${formatHour(existing.end_hour)}`;
      const existingName = existing.name ? ` "${existing.name}"` : '';
      const newTimeRange = `${formatHour(rule.start_hour)} - ${formatHour(rule.end_hour)}`;
      throw new Error(`This base schedule rule (${newTimeRange}) overlaps with an existing base schedule rule${existingName} (${existingTimeRange}). Please adjust the time range.`);
    }
  }
}

// Validate that override rules don't overlap with existing overrides for the same days
async function validateOverrideOverlap(rule, householdName) {
  if (rule.rule_type !== 'override') {
    return; // Only validate overrides
  }

  if (!householdName) {
    throw new Error('Household name is required to validate override overlap');
  }

  if (!rule.days || !Array.isArray(rule.days) || rule.days.length === 0) {
    throw new Error('Override rules must specify at least one day');
  }

  const overrideDays = rule.days;

  // Load all existing override rules for this household
  const { data, error } = await supabase
    .from('vibe_time_rules')
    .select('id, name, start_hour, end_hour, days')
    .eq('rule_type', 'override')
    .eq('household_name', householdName);

  if (error) {
    throw new Error('Failed to validate override overlap');
  }

  // Check for overlaps with existing overrides that share any common days
  const existingOverrides = (data || []).filter((existing) => {
    // Skip the rule being updated (if updating)
    if (rule.id && existing.id === rule.id) {
      return false;
    }
    // Check if it shares any common days
    if (!existing.days || !Array.isArray(existing.days) || existing.days.length === 0) {
      return false;
    }
    // Check if there's any day overlap
    return existing.days.some(day => overrideDays.includes(day));
  });

  // Check for time overlaps on shared days
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const existing of existingOverrides) {
    if (timeRangesOverlap(rule.start_hour, rule.end_hour, existing.start_hour, existing.end_hour)) {
      // Find which days overlap
      const sharedDays = existing.days.filter(day => overrideDays.includes(day));
      const dayNamesList = sharedDays.map(day => dayNames[day]).join(', ');
      const existingTimeRange = `${formatHour(existing.start_hour)} - ${formatHour(existing.end_hour)}`;
      const existingName = existing.name ? ` "${existing.name}"` : '';
      const newTimeRange = `${formatHour(rule.start_hour)} - ${formatHour(rule.end_hour)}`;
      throw new Error(`This override (${newTimeRange}) overlaps with an existing override${existingName} (${existingTimeRange}) for ${dayNamesList}. Please adjust the time range.`);
    }
  }
}

export async function saveVibeTimeRule(rule, householdName) {
  if (!householdName) {
    throw new Error('Household name is required to save vibe time rule');
  }
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
      // Override rules must have at least one day
      if (rule.days === null || rule.days === undefined || !Array.isArray(rule.days) || rule.days.length === 0) {
        throw new Error('Override rules must specify at least one day');
      }
      const validDays = rule.days.filter(
        (day) => typeof day === 'number' && day >= 0 && day <= 6
      );
      // Remove duplicates and sort
      days = [...new Set(validDays)].sort();
      if (days.length === 0) {
        throw new Error('Override rules must specify at least one day');
      }
    } else {
      // Base rules must have days = null
      if (rule.days !== null && rule.days !== undefined) {
        throw new Error('Base schedule rules cannot specify days');
      }
      days = null;
    }

    // Validate overlaps before saving
    if (ruleType === 'base') {
      await validateBaseScheduleOverlap({
        ...rule,
        rule_type: ruleType,
        days: days
      }, householdName);
    } else {
      await validateOverrideOverlap({
        ...rule,
        rule_type: ruleType,
        days: days
      }, householdName);
    }

    // Sanitize name (optional field)
    let name = rule.name && typeof rule.name === 'string' ? rule.name.trim() : null;
    if (name && name.length === 0) {
      // Empty string becomes null
      name = null;
    }

    const row = {
      name: name,
      start_hour: rule.start_hour,
      end_hour: rule.end_hour,
      allowed_vibes: validVibes,
      days: days,
      rule_type: ruleType,
      household_name: householdName
    };

    if (rule.id) {
      // Update existing rule - verify it belongs to this household
      // First check if the rule exists and belongs to this household
      const { data: existingRule, error: checkError } = await supabase
        .from('vibe_time_rules')
        .select('household_name')
        .eq('id', rule.id)
        .single();

      if (checkError || !existingRule) {
        throw new Error('Rule not found');
      }

      if (existingRule.household_name !== householdName) {
        throw new Error('You can only modify your own rules');
      }

      // Update existing rule
      const { data, error } = await supabase
        .from('vibe_time_rules')
        .update(row)
        .eq('id', rule.id)
        .eq('household_name', householdName)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return {
        id: data.id,
        name: data.name,
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
        name: data.name,
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

export async function deleteVibeTimeRule(id, householdName) {
  if (!householdName) {
    throw new Error('Household name is required to delete vibe time rule');
  }
  try {
    if (!id || typeof id !== 'number') {
      throw new Error('Invalid rule ID');
    }

    // Verify the rule belongs to this household before deleting
    const { data: existingRule, error: checkError } = await supabase
      .from('vibe_time_rules')
      .select('household_name')
      .eq('id', id)
      .single();

    if (checkError || !existingRule) {
      throw new Error('Rule not found');
    }

    if (existingRule.household_name !== householdName) {
      throw new Error('You can only delete your own rules');
    }

    const { error } = await supabase
      .from('vibe_time_rules')
      .delete()
      .eq('id', id)
      .eq('household_name', householdName);

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

