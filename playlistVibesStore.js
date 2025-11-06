import fs from 'fs/promises';

const PATH = './.playlist-vibes.json';
const VALID_VIBES = ['Down', 'Down/Mid', 'Mid'];

export async function loadPlaylistVibes() {
  try {
    const raw = await fs.readFile(PATH, 'utf8');
    const data = JSON.parse(raw);

    const sanitized = {};
    Object.entries(data || {}).forEach(([playlistId, vibe]) => {
      if (typeof vibe === 'string' && VALID_VIBES.includes(vibe)) {
        sanitized[playlistId] = vibe;
      }
    });

    return sanitized;
  } catch {
    return {};
  }
}

export async function savePlaylistVibes(map) {
  const sanitized = {};
  Object.entries(map || {}).forEach(([playlistId, vibe]) => {
    if (typeof playlistId === 'string' && typeof vibe === 'string' && VALID_VIBES.includes(vibe)) {
      sanitized[playlistId] = vibe;
    }
  });

  await fs.writeFile(PATH, JSON.stringify(sanitized, null, 2), 'utf8');
  return sanitized;
}

export function getValidVibes() {
  return [...VALID_VIBES];
}

