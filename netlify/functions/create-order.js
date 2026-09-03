/*
 * POST /api/create-order
 *
 * PUBLIC. Rebuilds and validates the customer's cart entirely from
 * Firestore (see _shared/orderValidation.js) — no price, fee, total, or
 * stock claim from the browser is ever trusted. On success, creates a
 * permanent order snapshot that never changes even if the catalog changes
 * later.
 *
 * Idempotency: the browser generates BOTH `idempotencyKey` and the raw
 * `orderAccessToken` itself (never the server) — so a retry of the exact
 * same submission already holds its own token and needs nothing recovered.
 * The server only ever stores the token's SHA-256 hash. A request whose
 * idempotencyKey matches a prior one but whose payload fingerprint differs
 * is rejected outright — it must never silently return someone else's
 * order. `orderNumbers/{candidate}` is claimed inside the same transaction
 * that creates the order (same pattern as skuIndex), retried with a fresh
 * candidate on the astronomically rare collision.
 *
 * Phase 5D: on the "creating fresh" branch only (never the idempotent-
 * replay branch), the same transaction also reserves inventory for the
 * whole cart via _shared/inventory.js's reserveInventory — all of its
 * reads happen after the idempotency/order-number reads and before any of
 * this function's own writes, satisfying Firestore's read-before-write
 * transaction rule. If reserveInventory throws InsufficientStockError, it
 * propagates out of the retry loop below (never treated as an
 * OrderNumberCollision) and is caught by the outer handler to produce the
 * same CART_INVALID/OUT_OF_STOCK response shape orderValidation.js's Pass 2
 * already produces.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail, json } = require('./_shared/response');
const { ValidationError, requireString, optionalString, requireEmail, requireMobile } = require('./_shared/validation');
const { resolveAndValidateCart, CartInvalidError } = require('./_shared/orderValidation');
const { getShippingSettings, getPaymentSettings } = require('./_shared/settings');
const { validateDestination, resolveShippingQuote } = require('./_shared/shippingRates');
const { generateOrderNumberCandidate, isValidAccessToken, isValidIdempotencyKey, hashToken, computeRequestFingerprint } = require('./_shared/orderSecurity');
const { reserveInventory, freshExpiry, InsufficientStockError } = require('./_shared/inventory');

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

class OrderNumberCollision extends Error {}

/*
 * Phase 5D.2: `barangay` is required for new delivery orders. Orders
 * created before this phase have no barangay field at all — that is
 * historical data and is never backfilled or re-validated; only NEW
 * submissions pass through here.
 */
function validateDeliveryAddress(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Delivery address is required.');
  return {
    line1: requireString(raw.line1, 'Address line 1', { maxLength: 200 }),
    line2: optionalString(raw.line2, 'Address line 2', { maxLength: 200 }),
    barangay: requireString(raw.barangay, 'Barangay', { maxLength: 100 }),
    city: requireString(raw.city, 'City/Municipality', { maxLength: 100 }),
    province: requireString(raw.province, 'Province', { maxLength: 100 }),
    postalCode: requireString(raw.postalCode, 'Postal code', { maxLength: 20 }),
  };
}

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const body = JSON.parse(event.body || '{}');
  const db = getDb();

  const idempotencyKey = requireString(body.idempotencyKey, 'idempotencyKey', { maxLength: 100 });
  if (!isValidIdempotencyKey(idempotencyKey)) throw new ValidationError('Invalid idempotency key.');

  const orderAccessToken = requireString(body.orderAccessToken, 'orderAccessToken', { maxLength: 100 });
  if (!isValidAccessToken(orderAccessToken)) throw new ValidationError('Invalid order access token.');

  const customer = body.customer || {};
  const fullName = requireString(customer.fullName, 'Full name', { maxLength: 100 });
  const email = requireEmail(customer.email);
  const mobile = requireMobile(customer.mobile);

  const orderNotes = optionalString(body.orderNotes, 'Order notes', { maxLength: 500 });

  const [shipping, paymentSettings] = await Promise.all([getShippingSettings(db), getPaymentSettings(db)]);

  // ---- Phase 5D.2 master switch ----
  // The store is not purchasable until the Owner explicitly flips
  // settings/payment.checkoutEnabled to true (Owner-only, Admin -> Settings).
  // Enforced HERE, server-side, so no frontend deploy, cached page, or
  // crafted request can create an order before the Owner is ready. Fails
  // closed: a missing field reads as false (see _shared/settings.js).
  //
  // This deliberately gates ORDER CREATION only. Orders that already exist
  // stay payable/reviewable if checkout is later switched off, so toggling
  // it never strands a customer who has already been asked for money.
  if (!paymentSettings.checkoutEnabled) {
    return json(503, {
      error: 'CHECKOUT_DISABLED',
      message: 'Online checkout is not open yet. Please contact us to place your order.',
    });
  }

  // Validates the delivery method and, for delivery, that the destination
  // region is one of luzon|visayas|mindanao. Pickup forces the region to
  // null — a region sent with a pickup order is ignored, never priced.
  const { deliveryMethod, destinationRegion } = validateDestination(body.deliveryMethod, body.destinationRegion);

  const deliveryAddress = deliveryMethod === 'delivery' ? validateDeliveryAddress(body.deliveryAddress) : null;

  let cartResult;
  try {
    cartResult = await resolveAndValidateCart(body.items, db);
  } catch (err) {
    if (err instanceof CartInvalidError) {
      return json(400, { error: 'CART_INVALID', reason: err.reason, lineIndex: err.lineIndex, message: err.message });
    }
    throw err;
  }
  const { lines, subtotal, resources } = cartResult;

  // Denormalized, flat, deduplicated reference lists — Firestore's
  // array-contains can't match "does any object in items[] have field X"
  // since items[] holds rich snapshot objects, not primitives. These three
  // arrays are what admin-delete-product.js/admin-delete-patch.js/
  // admin-remove-image.js query to decide whether a permanent delete or
  // Storage object removal would damage this order's historical integrity.
  const referencedProductIds = [...new Set(lines.map((l) => l.productId))];
  const referencedPatchIds = [...new Set(lines.flatMap((l) => (l.customization ? l.customization.patches.map((p) => p.patchId) : [])))];
  // Same flat-array workaround, used by _shared/reservationReferences.js to
  // decide whether a product/patch is currently held by an active/locked
  // reservation before it can be permanently deleted.
  const resourceProductIds = [...new Set(resources.filter((r) => r.type === 'variant').map((r) => r.productId))];
  const resourcePatchIds = [...new Set(resources.filter((r) => r.type === 'patch').map((r) => r.patchId))];
  const referencedImagePaths = [
    ...new Set([
      ...lines.map((l) => l.thumbnailImagePath).filter(Boolean),
      ...lines.map((l) => (l.customization ? l.customization.variant.stageImagePath : null)).filter(Boolean),
      ...lines.flatMap((l) => (l.customization ? l.customization.patches.map((p) => p.imagePath) : [])).filter(Boolean),
    ]),
  ];

  // ---- Authoritative shipping + grand total ----
  // `subtotal` came from resolveAndValidateCart, which re-priced every line
  // against live Firestore product/patch prices. The quote below comes from
  // settings/shipping via the rate-provider layer. NOTHING here is read
  // from the request body: a browser that posts its own shippingFee or
  // total is simply ignored — those keys are never looked at.
  const quote = resolveShippingQuote({ deliveryMethod, destinationRegion, itemSubtotal: subtotal, shipping });
  const shippingFee = quote.shippingFee;
  const total = subtotal + shippingFee;

  const fingerprint = computeRequestFingerprint({
    customer: { fullName, email, mobile },
    deliveryMethod,
    destinationRegion,
    deliveryAddress,
    orderNotes,
    items: body.items,
  });

  const accessTokenHash = hashToken(orderAccessToken);
  const idempRef = db.collection('orderIdempotency').doc(idempotencyKey);

  let result;
  try {
    for (let attempt = 0; attempt < MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
      const candidateNumber = generateOrderNumberCandidate();
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await db.runTransaction(async (tx) => {
          const idempSnap = await tx.get(idempRef);
          if (idempSnap.exists) {
            const existing = idempSnap.data();
            if (existing.fingerprint !== fingerprint) {
              return { ok: false, status: 409, error: 'This idempotency key was already used for a different order request.' };
            }
            return { ok: true, orderNumber: existing.orderNumber };
          }

          const orderNumberRef = db.collection('orderNumbers').doc(candidateNumber);
          const numSnap = await tx.get(orderNumberRef);
          if (numSnap.exists) throw new OrderNumberCollision();

          const orderRef = db.collection('orders').doc();
          const reservationRef = db.collection('inventoryReservations').doc(orderRef.id);
          const now = admin.firestore.Timestamp.now();
          const serverNow = admin.firestore.FieldValue.serverTimestamp();

          // Reads all inventory it needs and validates availability BEFORE
          // any write below — throws InsufficientStockError (never treated
          // as an order-number collision) if the whole-cart demand can't be
          // met, aborting the entire transaction with nothing written.
          await reserveInventory(tx, db, resources);

          tx.set(orderRef, {
            orderNumber: candidateNumber,
            accessTokenHash,
            idempotencyKey,
            customerName: fullName,
            customerEmail: email,
            customerMobile: mobile,
            deliveryMethod,
            // Phase 5D.2: null for pickup, luzon|visayas|mindanao for
            // delivery. Part of the permanent order snapshot — Admin reads
            // this, never re-derives it from the address.
            destinationRegion,
            deliveryAddress,
            orderNotes,
            items: lines,
            referencedProductIds,
            referencedPatchIds,
            referencedImagePaths,
            // Server-controlled, always false through this public endpoint —
            // never read from the request body. There is no "create a test
            // order" path through create-order.js; a future Owner-only tool
            // that needs to create genuine test orders would set this true
            // itself, server-side, the same way this sets it false.
            isTest: false,
            inventoryStatus: 'reserved',
            // PERMANENT PRICING SNAPSHOT. These three numbers are frozen at
            // order time and are never recalculated from current settings —
            // if Luzon later moves from 150 to 180, this order still shows
            // and still owes exactly what it was charged. `shippingRate`
            // records WHERE the fee came from (which region/pickup/free-
            // shipping rule) so an old order stays explainable even after
            // the rate table changes underneath it.
            pricing: {
              subtotal,
              shippingFee,
              total,
              shippingRate: {
                source: quote.rateSource,
                regionLabel: quote.regionLabel,
                freeShippingApplied: quote.freeShippingApplied,
              },
            },
            paymentStatus: 'awaiting_payment',
            fulfillmentStatus: 'unfulfilled',
            // Phase 5D.2: populated only by the "mark shipped" transition on
            // a delivery order (admin-update-fulfillment.js). Never cleared
            // by any later status change.
            courier: null,
            trackingNumber: null,
            paymentAttempts: [],
            history: [
              { action: 'created', at: now, actorType: 'customer', actorId: null, meta: {} },
              { action: 'inventory_reserved', at: now, actorType: 'system', actorId: null, meta: {} },
            ],
            createdAt: serverNow,
            updatedAt: serverNow,
          });
          tx.set(reservationRef, {
            orderId: orderRef.id,
            orderNumber: candidateNumber,
            status: 'active',
            resources,
            resourceProductIds,
            resourcePatchIds,
            createdAt: now,
            expiresAt: freshExpiry(now),
            updatedAt: now,
            history: [{ action: 'created', at: now, actorType: 'customer', actorId: null, meta: {} }],
          });
          tx.set(orderNumberRef, { orderId: orderRef.id, createdAt: serverNow });
          tx.set(idempRef, { fingerprint, orderId: orderRef.id, orderNumber: candidateNumber, createdAt: serverNow });

          return { ok: true, orderNumber: candidateNumber };
        });
        break;
      } catch (err) {
        if (err instanceof OrderNumberCollision) continue;
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return json(400, { error: 'CART_INVALID', reason: 'OUT_OF_STOCK', lineIndex: null, message: 'Sorry, part of your cart is no longer available in the quantity requested.' });
    }
    throw err;
  }

  if (!result) throw new Error('Could not generate a unique order number after several attempts.');
  if (!result.ok) return fail(result.status, result.error);

  return ok({ orderNumber: result.orderNumber });
});
