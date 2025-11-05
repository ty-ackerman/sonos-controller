import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { jest } from '@jest/globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const originalCwd = process.cwd();

export async function createTempWorkspace() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonos-controller-'));
  return tempDir;
}

export async function setupTestApp({
  tokens,
  appState,
  householdId = 'HID',
  primaryGroupId = null
} = {}) {
  const tempDir = await createTempWorkspace();

  process.chdir(tempDir);

  const defaultTokens = {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: Date.now() + 60 * 60 * 1000
  };

  const defaultAppState = {
    primaryGroupId: primaryGroupId ?? null,
    lastHouseholdId: primaryGroupId ? householdId : null
  };

  await fs.writeFile('.tokens.json', JSON.stringify(tokens ?? defaultTokens, null, 2), 'utf8');
  await fs.writeFile('.appstate.json', JSON.stringify(appState ?? defaultAppState, null, 2), 'utf8');

  process.env.NODE_ENV = 'test';
  process.env.SONOS_CLIENT_ID = process.env.SONOS_CLIENT_ID || 'client';
  process.env.SONOS_CLIENT_SECRET = process.env.SONOS_CLIENT_SECRET || 'secret';
  process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost/callback';

  jest.resetModules();

  const serverModuleUrl = pathToFileURL(path.join(projectRoot, 'server.js')).href;
  const { default: app } = await import(serverModuleUrl);

  const cleanup = async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  return { app, tempDir, cleanup };
}

export function restoreCwd() {
  process.chdir(originalCwd);
}
