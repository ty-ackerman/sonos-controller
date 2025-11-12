-- Table for storing OAuth state -> device ID mappings
-- These are temporary and will be cleaned up after OAuth callback
-- REQUIRED: Run this SQL in your Supabase SQL Editor before using device-specific sessions
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for cleanup of old states (older than 10 minutes)
CREATE INDEX IF NOT EXISTS idx_oauth_states_created_at ON oauth_states(created_at);

-- Function to clean up old OAuth states (older than 10 minutes)
-- You can call this periodically: SELECT cleanup_old_oauth_states();
CREATE OR REPLACE FUNCTION cleanup_old_oauth_states()
RETURNS void AS $$
BEGIN
  DELETE FROM oauth_states WHERE created_at < NOW() - INTERVAL '10 minutes';
END;
$$ LANGUAGE plpgsql;

