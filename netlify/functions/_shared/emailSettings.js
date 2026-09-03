/*
 * Reads settings/email — the Owner-controlled email mode. Same fail-closed
 * pattern as _shared/settings.js's shipping/payment readers: absence of the
 * document, or an unrecognized value, always resolves to the SAFEST state
 * ('off'), never to 'qa' or 'live'.
 *
 * mode: 'off' | 'qa' | 'live'
 *   off  — no email leaves this app. New events enqueue as suppressed_disabled.
 *   qa   — every otherwise-sendable email is redirected to
 *          EMAIL_QA_OVERRIDE_RECIPIENT. Real customer/admin addresses are
 *          never used while in this mode (enforced in _shared/emailOutbox.js,
 *          not just here).
 *   live — emails go to their real, snapshotted recipients.
 *
 * isTest:true always overrides mode entirely (suppressed_test) — see
 * _shared/emailOutbox.js. This module only resolves the STORED mode; it
 * does not know about any particular order.
 */
const { getDb } = require('./firebaseAdmin');

const VALID_MODES = ['off', 'qa', 'live'];
const DEFAULT_EMAIL_SETTINGS = { mode: 'off' };

/**
 * Pass `tx` when reading from inside a Firestore transaction that will
 * also write — required by Firestore's reads-before-writes rule.
 * enqueueEmail()'s callers all read the mode this way, early in their own
 * transaction, before any business-state write.
 */
async function getEmailSettings(db, tx = null) {
  const ref = (db || getDb()).collection('settings').doc('email');
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) return { ...DEFAULT_EMAIL_SETTINGS };
  const data = snap.data();
  const mode = VALID_MODES.includes(data.mode) ? data.mode : 'off';
  return { mode };
}

module.exports = { VALID_MODES, DEFAULT_EMAIL_SETTINGS, getEmailSettings };
