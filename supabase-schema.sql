-- Supabase schema for Sonos Controller
-- Run this SQL in your Supabase SQL Editor

-- Table for storing Sonos OAuth tokens
-- Using device_id as primary key to support device-specific authentication
CREATE TABLE IF NOT EXISTS tokens (
  device_id TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for storing speaker volume settings
CREATE TABLE IF NOT EXISTS speaker_volumes (
  player_id TEXT PRIMARY KEY,
  volume INTEGER NOT NULL CHECK (volume >= 0 AND volume <= 100),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for storing playlist vibes
CREATE TABLE IF NOT EXISTS playlist_vibes (
  playlist_id TEXT PRIMARY KEY,
  vibe TEXT NOT NULL CHECK (vibe IN ('Down', 'Down/Mid', 'Mid')),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for storing vibe time rules
CREATE TABLE IF NOT EXISTS vibe_time_rules (
  id SERIAL PRIMARY KEY,
  household_name TEXT NOT NULL,
  name TEXT,
  start_hour INTEGER NOT NULL CHECK (start_hour >= 0 AND start_hour <= 23),
  end_hour INTEGER NOT NULL CHECK (end_hour >= 0 AND end_hour <= 23),
  allowed_vibes TEXT[] NOT NULL,
  days INTEGER[] CHECK (days IS NULL OR (array_length(days, 1) > 0 AND array_length(days, 1) <= 7)),
  rule_type TEXT NOT NULL CHECK (rule_type IN ('base', 'override')) DEFAULT 'base',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for storing hidden favorites (favorites that should not appear in Controls section)
CREATE TABLE IF NOT EXISTS hidden_favorites (
  favorite_id TEXT PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for storing OAuth states per device during authentication flow
CREATE TABLE IF NOT EXISTS oauth_states (
  device_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_tokens_updated_at ON tokens(updated_at);
CREATE INDEX IF NOT EXISTS idx_speaker_volumes_updated_at ON speaker_volumes(updated_at);
CREATE INDEX IF NOT EXISTS idx_playlist_vibes_updated_at ON playlist_vibes(updated_at);
CREATE INDEX IF NOT EXISTS idx_vibe_time_rules_updated_at ON vibe_time_rules(updated_at);
CREATE INDEX IF NOT EXISTS idx_vibe_time_rules_household_name ON vibe_time_rules(household_name);
CREATE INDEX IF NOT EXISTS idx_hidden_favorites_updated_at ON hidden_favorites(updated_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_created_at ON oauth_states(created_at);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to automatically update updated_at
CREATE TRIGGER update_tokens_updated_at BEFORE UPDATE ON tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_speaker_volumes_updated_at BEFORE UPDATE ON speaker_volumes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_playlist_vibes_updated_at BEFORE UPDATE ON playlist_vibes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vibe_time_rules_updated_at BEFORE UPDATE ON vibe_time_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_hidden_favorites_updated_at BEFORE UPDATE ON hidden_favorites
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Note: Tokens are now device-specific. No initial insert needed.
-- Each device will create its own token row on first login.

-- Migration: Replace device_id with household_name in existing vibe_time_rules table
-- Run this AFTER the table structure is updated:
-- ALTER TABLE vibe_time_rules ADD COLUMN IF NOT EXISTS household_name TEXT;
-- UPDATE vibe_time_rules SET household_name = 'Alter: College West' WHERE household_name IS NULL;
-- ALTER TABLE vibe_time_rules DROP COLUMN IF EXISTS device_id;
-- ALTER TABLE vibe_time_rules ALTER COLUMN household_name SET NOT NULL;

