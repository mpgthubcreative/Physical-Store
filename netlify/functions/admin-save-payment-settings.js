/*
 * POST /api/admin-save-payment-settings
 *
 * OWNER ONLY (requireOwner). Payment account details and the checkout
 * master switch decide where customers send real money and whether the
 * store can take orders at all — a normal Admin must not be able to change
 * either, and in particular must not be able to activate checkout. The
 * Admin UI hides these controls for a non-Owner, but that is UX only: this
 * check is the enforcement.
 *
 * ---- Non-destructive by construction ----
 * Writes with { merge: true } and only ever sets `checkoutEnabled`,
 * `gcash.*`, and `bank.*`. The pre-5D.2 `methods[]` array is NEVER written
 * and NEVER deleted — it stays on the document, and _shared/settings.js
 * keeps merging any method it holds that gcash/bank don't cover.
 *
 * `qrImagePath` is deliberately NOT settable here. QR images are owned
 * exclusively by the existing signed-URL upload pipeline
 * (admin-request-image-upload -> admin-finalize-image-upload) and cleared
 * by admin-remove-image. Because this writes nested maps with merge:true,
 * an existing gcash.qrImagePath / bank.qrImagePath survives every save made
 * from this endpoint — saving the account name can never orphan the QR.
 *
 * ---- Enabling a method requires it to be usable ----
 * A method can only be marked enabled if it carries the details a customer
 * would actually need to pay with it. Otherwise the payment page would
 * render a method the customer cannot use.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireOwner } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireBoolean, optionalString } = require('./_shared/validation');
const { normalizePaymentSettings } = require('./_shared/settings');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  // Owner-only. An Admin token is rejected here with 403 even though it
  // passes requireAdmin() elsewhere in the app.
  const auth = await requireOwner(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const rawGcash = body.gcash && typeof body.gcash === 'object' ? body.gcash : {};
  const rawBank = body.bank && typeof body.bank === 'object' ? body.bank : {};

  const gcash = {
    enabled: requireBoolean(rawGcash.enabled, 'GCash enabled'),
    accountName: optionalString(rawGcash.accountName, 'GCash account name', { maxLength: 120 }),
    mobileNumber: optionalString(rawGcash.mobileNumber, 'GCash mobile number', { maxLength: 40 }),
    instructions: optionalString(rawGcash.instructions, 'GCash instructions', { maxLength: 500 }),
  };
  const bank = {
    enabled: requireBoolean(rawBank.enabled, 'Bank transfer enabled'),
    bankName: optionalString(rawBank.bankName, 'Bank name', { maxLength: 120 }),
    accountName: optionalString(rawBank.accountName, 'Bank account name', { maxLength: 120 }),
    accountNumber: optionalString(rawBank.accountNumber, 'Bank account number', { maxLength: 60 }),
    instructions: optionalString(rawBank.instructions, 'Bank instructions', { maxLength: 500 }),
  };

  if (gcash.enabled && (!gcash.accountName || !gcash.mobileNumber)) {
    throw new ValidationError('Enable GCash only after entering the GCash account name and mobile number.');
  }
  if (bank.enabled && (!bank.bankName || !bank.accountName || !bank.accountNumber)) {
    throw new ValidationError('Enable Bank Transfer only after entering the bank name, account name, and account number.');
  }

  const checkoutEnabled = requireBoolean(body.checkoutEnabled, 'Checkout enabled');

  const db = getDb();
  const ref = db.collection('settings').doc('payment');

  // Turning checkout ON is the single most consequential setting in the
  // store, so it is gated on the configuration actually being usable —
  // checking the MERGED view (new gcash/bank plus any surviving legacy
  // methods[]) so a store still running on the pre-5D.2 shape isn't
  // wrongly told it has nothing enabled.
  if (checkoutEnabled) {
    const snap = await ref.get();
    const merged = normalizePaymentSettings({
      ...(snap.exists ? snap.data() : {}),
      gcash: { ...(snap.exists && snap.data().gcash ? snap.data().gcash : {}), ...gcash },
      bank: { ...(snap.exists && snap.data().bank ? snap.data().bank : {}), ...bank },
    });
    if (!merged.methods.some((m) => m.enabled)) {
      throw new ValidationError('Enable at least one payment method before turning checkout on.');
    }
  }

  await ref.set(
    {
      checkoutEnabled,
      gcash,
      bank,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: auth.uid,
    },
    // merge:true — nested-map merge, so gcash.qrImagePath / bank.qrImagePath
    // and the legacy methods[] array all survive untouched.
    { merge: true }
  );

  return ok({ saved: true, checkoutEnabled });
});
