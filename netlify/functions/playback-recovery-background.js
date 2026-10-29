// Fast path for stall recovery. The status poll starts this (a Netlify "background" function: it
// answers right away and keeps running for up to 15 minutes) the moment it sees the Roam idle at
// the start of a track. It runs the same guarded check as the scheduled function.
// The logic lives in ../../stallRecovery.js.
import { runRecoveryCheck } from '../../stallRecovery.js';

export default async () => {
  await runRecoveryCheck();
  return new Response('OK');
};
