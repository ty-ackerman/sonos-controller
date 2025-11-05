import fs from 'fs/promises';
import path from 'path';

const TOK_PATH = path.resolve('./.tokens.json');

export async function loadTokens() {
  try {
    const raw = await fs.readFile(TOK_PATH, 'utf8');
    const t = JSON.parse(raw);
    return {
      access_token: t.access_token || null,
      refresh_token: t.refresh_token || null,
      expires_at: Number(t.expires_at || 0)
    };
  } catch {
    return { access_token: null, refresh_token: null, expires_at: 0 };
  }
}

export async function saveTokens(tokens) {
  const toSave = {
    access_token: tokens.access_token || null,
    refresh_token: tokens.refresh_token || null,
    expires_at: Number(tokens.expires_at || 0)
  };
  await fs.writeFile(TOK_PATH, JSON.stringify(toSave, null, 2), 'utf8');
}

export async function clearTokens() {
  try {
    await fs.unlink(TOK_PATH);
  } catch {
    // ignore cleanup errors
  }
  return { access_token: null, refresh_token: null, expires_at: 0 };
}
