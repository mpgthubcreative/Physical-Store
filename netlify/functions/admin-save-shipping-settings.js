/*
 * POST /api/admin-save-shipping-settings
 *
 * Owner AND Admin (requireAdmin) — shipping rates are ordinary day-to-day
 * store configuration, unlike payment account details.
 *
 * ---- Non-destructive by construction ----
 * Writes with { merge: true } and only ever sets the keys below. The
 * pre-5D.2 `flatRateDelivery` field is NEVER written and NEVER deleted here
 * — it stays on the document untouched as historical configuration.
 * _shared/settings.js only falls back to it when regional rates are absent,
 * so once real rates are saved it simply stops being consulted.
 *
 * Rates are validated as non-negative numbers. Saving a blank rate stores
 * null, which makes delivery to that region REFUSED (see shippingRates.js)
 * rather than free — an unconfigured region must never ship for ₱0.
 *
 * Changing a rate here has NO effect on any existing order: every order
 * froze its own pricing snapshot at creation time and is never recalculated.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireBoolean, requireNumber } = require('./_shared/validation');
const { DESTINATION_REGIONS } = require('./_shared/settings');

const MAX_RATE = 100000;

/** '' / null / undefined -> null (unconfigured). Any provided value must be a non-negative number. */
function optionalRate(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  return requireNumber(value, fieldName, { min: 0, max: MAX_RATE });
}

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');

  const deliveryEnabled = requireBoolean(body.deliveryEnabled, 'Delivery enabled');
  const pickupEnabled = requireBoolean(body.pickupEnabled, 'Pickup enabled');
  const pickupFee = optionalRate(body.pickupFee, 'Pickup fee') ?? 0;

  // Persist 0 as null. A zero threshold would mean "every order ships
  // free", silently bypassing every regional rate — never what an Owner
  // means by typing 0 into a "free shipping above" box. Storing null keeps
  // the stored document unambiguous rather than relying on every reader to
  // reinterpret 0 correctly.
  const rawThreshold = optionalRate(body.freeShippingThreshold, 'Free shipping threshold');
  const freeShippingThreshold = rawThreshold !== null && rawThreshold > 0 ? rawThreshold : null;

  const rawRates = body.rates && typeof body.rates === 'object' ? body.rates : {};
  const rates = {};
  for (const region of DESTINATION_REGIONS) {
    rates[region] = optionalRate(rawRates[region], `${region} rate`);
  }

  // Refuse a configuration that would advertise delivery it cannot price —
  // this is the same fail-closed principle the rate provider applies at
  // order time, surfaced early as a clear admin error instead of a
  // customer-facing failure later.
  if (deliveryEnabled && DESTINATION_REGIONS.every((r) => rates[r] === null)) {
    throw new ValidationError('Enable delivery only after setting at least one regional rate.');
  }
  if (!deliveryEnabled && !pickupEnabled) {
    throw new ValidationError('At least one of delivery or pickup must stay enabled.');
  }

  const db = getDb();
  await db.collection('settings').doc('shipping').set(
    {
      deliveryEnabled,
      pickupEnabled,
      pickupFee,
      freeShippingThreshold,
      rates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: auth.uid,
    },
    // merge:true — leaves flatRateDelivery and any other pre-existing key
    // on the document exactly as they were.
    { merge: true }
  );

  return ok({ saved: true, rates, deliveryEnabled, pickupEnabled, pickupFee, freeShippingThreshold });
});
