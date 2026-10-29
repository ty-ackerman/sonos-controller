// Scheduled backstop for stall recovery: checks once a minute, even if nobody has the page open.
// The logic lives in ../../stallRecovery.js.
import { runRecoveryCheck } from '../../stallRecovery.js';

export default async () => {
  await runRecoveryCheck();
  return new Response('OK');
};

export const config = {
  schedule: '@every 1m'
};
