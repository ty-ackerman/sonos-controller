-- Migration script to convert tokens table from fixed id=1 to device_id-based
-- Run this SQL in your Supabase SQL Editor
--
-- IMPORTANT: This migration will clear all existing authentication tokens.
-- Users will need to re-authenticate on their devices after this migration.
--
-- Steps:
-- 1. Backup existing tokens (optional)
-- 2. Drop old table structure
-- 3. Create new table with device_id as primary key
-- 4. Restore triggers

-- Step 1: Optional - Backup existing tokens before migration
-- Uncomment the next line if you want to preserve the old token data
-- CREATE TABLE tokens_backup AS SELECT * FROM tokens;

-- Step 2: Drop the old table (this will clear all tokens)
-- Since we're changing from INTEGER id to TEXT device_id as primary key,
-- we need to recreate the table structure
DROP TABLE IF EXISTS tokens CASCADE;

-- Step 3: Create the new tokens table with device_id as primary key
CREATE TABLE tokens (
  device_id TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 4: Recreate the trigger for automatic updated_at timestamp
CREATE TRIGGER update_tokens_updated_at BEFORE UPDATE ON tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Migration complete!
-- 
-- What happened:
-- - Old tokens table (with id=1 constraint) has been removed
-- - New tokens table created with device_id as primary key
-- - All existing authentication tokens have been cleared
--
-- Next steps:
-- 1. Users will need to log in again on their devices
-- 2. Each device will get its own unique device_id and token set
-- 3. Authentication sessions are now device-specific
--
-- Optional cleanup (run after verifying migration worked):
-- DROP TABLE IF EXISTS tokens_backup;

