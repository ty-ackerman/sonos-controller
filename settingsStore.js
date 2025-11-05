import fs from 'fs/promises';

const PATH = './.speaker-volumes.json';

export async function loadSpeakerVolumes() {
  try {
    const raw = await fs.readFile(PATH, 'utf8');
    const data = JSON.parse(raw);

    const sanitized = {};
    Object.keys(data || {}).forEach((key) => {
      const value = Number(data[key]);
      const normalized = Number.isFinite(value) ? value : 0;
      sanitized[key] = Math.max(0, Math.min(100, normalized));
    });

    return sanitized;
  } catch {
    return {};
  }
}

export async function saveSpeakerVolumes(map) {
  const sanitized = {};
  Object.entries(map || {}).forEach(([key, value]) => {
    const numeric = Number(value);
    const normalized = Number.isFinite(numeric) ? numeric : 0;
    sanitized[key] = Math.max(0, Math.min(100, normalized));
  });

  await fs.writeFile(PATH, JSON.stringify(sanitized, null, 2), 'utf8');
  return sanitized;
}

