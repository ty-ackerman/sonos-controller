import fs from 'fs/promises';

const PATH = './.appstate.json';

export async function loadAppState() {
  try {
    return JSON.parse(await fs.readFile(PATH, 'utf8'));
  } catch {
    return { primaryGroupId: null, lastHouseholdId: null };
  }
}

export async function saveAppState(state) {
  await fs.writeFile(PATH, JSON.stringify(state, null, 2), 'utf8');
}
