// Fast path for stall recovery. The status poll starts this (a Netlify "background" function: it
// answers right away and keeps running for up to 15 minutes) the moment it sees the Roam idle at
// the start of a track. It runs the same guarded check as the scheduled function.
// The logic lives in ../../stallRecovery.js.
import { runRecoveryCheck, recoverAfterError, recoverIfStillBuffering, resubscribeHousehold } from '../../stallRecovery.js';

// Started two ways:
//  - by the Sonos event receiver with { groupId, householdId } the moment a playbackError arrives (fastest)
//  - by the status poll with no body, which runs the regular guarded check
export default async (req) => {
  let body = null;
  try {
    body = await req.json();
  } catch (_) {
    body = null;
  }
  if (body?.resubscribe) {
    await resubscribeHousehold(body.householdId);
  } else if (body?.groupId && body.bufferWatch) {
    await recoverIfStillBuffering(body.groupId, body.householdId, body.itemId, body.bufferedAt);
  } else if (body?.groupId) {
    await recoverAfterError(body.groupId, body.householdId, body.errorAt);
  } else {
    await runRecoveryCheck();
  }
  return new Response('OK');
};
