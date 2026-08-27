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
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail, json } = require('./_shared/response');
const { ValidationError, requireString, optionalString, requireEmail, requireMobile, requireOneOf } = require('./_shared/validation');
const { resolveAndValidateCart, CartInvalidError } = require('./_shared/orderValidation');
const { getShippingSettings } = require('./_shared/settings');
const { generateOrderNumberCandidate, isValidAccessToken, isValidIdempotencyKey, hashToken, computeRequestFingerprint } = require('./_shared/orderSecurity');

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

class OrderNumberCollision extends Error {}

function validateDeliveryAddress(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Delivery address is required.');
  return {
    line1: requireString(raw.line1, 'Address line 1', { maxLength: 200 }),
    line2: optionalString(raw.line2, 'Address line 2', { maxLength: 200 }),
    city: requireString(raw.city, 'City', { maxLength: 100 }),
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

  const deliveryMethod = requireOneOf(body.deliveryMethod, 'deliveryMethod', ['delivery', 'pickup']);
  const orderNotes = optionalString(body.orderNotes, 'Order notes', { maxLength: 500 });

  const shipping = await getShippingSettings(db);

  let deliveryAddress = null;
  let shippingFeeBase;
  if (deliveryMethod === 'delivery') {
    if (!shipping.deliveryEnabled) throw new ValidationError('Delivery is not currently available. Please choose pickup.');
    if (shipping.flatRateDelivery == null) {
      throw new ValidationError('Delivery pricing is not yet configured. Please choose pickup or contact us.');
    }
    deliveryAddress = validateDeliveryAddress(body.deliveryAddress);
    shippingFeeBase = Number(shipping.flatRateDelivery);
  } else {
    if (!shipping.pickupEnabled) throw new ValidationError('Pickup is not currently available.');
    shippingFeeBase = Number(shipping.pickupFee || 0);
  }

  let cartResult;
  try {
    cartResult = await resolveAndValidateCart(body.items, db);
  } catch (err) {
    if (err instanceof CartInvalidError) {
      return json(400, { error: 'CART_INVALID', reason: err.reason, lineIndex: err.lineIndex, message: err.message });
    }
    throw err;
  }
  const { lines, subtotal } = cartResult;

  // Denormalized, flat, deduplicated reference lists — Firestore's
  // array-contains can't match "does any object in items[] have field X"
  // since items[] holds rich snapshot objects, not primitives. These three
  // arrays are what admin-delete-product.js/admin-delete-patch.js/
  // admin-remove-image.js query to decide whether a permanent delete or
  // Storage object removal would damage this order's historical integrity.
  const referencedProductIds = [...new Set(lines.map((l) => l.productId))];
  const referencedPatchIds = [...new Set(lines.flatMap((l) => (l.customization ? l.customization.patches.map((p) => p.patchId) : [])))];
  const referencedImagePaths = [
    ...new Set([
      ...lines.map((l) => l.thumbnailImagePath).filter(Boolean),
      ...lines.map((l) => (l.customization ? l.customization.variant.stageImagePath : null)).filter(Boolean),
      ...lines.flatMap((l) => (l.customization ? l.customization.patches.map((p) => p.imagePath) : [])).filter(Boolean),
    ]),
  ];

  let shippingFee = shippingFeeBase;
  if (deliveryMethod === 'delivery' && shipping.freeShippingThreshold != null && subtotal >= Number(shipping.freeShippingThreshold)) {
    shippingFee = 0;
  }
  const total = subtotal + shippingFee;

  const fingerprint = computeRequestFingerprint({
    customer: { fullName, email, mobile },
    deliveryMethod,
    deliveryAddress,
    orderNotes,
    items: body.items,
  });

  const accessTokenHash = hashToken(orderAccessToken);
  const idempRef = db.collection('orderIdempotency').doc(idempotencyKey);

  let result;
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
        const now = admin.firestore.FieldValue.serverTimestamp();

        tx.set(orderRef, {
          orderNumber: candidateNumber,
          accessTokenHash,
          idempotencyKey,
          customerName: fullName,
          customerEmail: email,
          customerMobile: mobile,
          deliveryMethod,
          deliveryAddress,
          orderNotes,
          items: lines,
          referencedProductIds,
          referencedPatchIds,
          referencedImagePaths,
          pricing: { subtotal, shippingFee, total },
          paymentStatus: 'awaiting_payment',
          fulfillmentStatus: 'unfulfilled',
          paymentAttempts: [],
          history: [{ action: 'created', at: admin.firestore.Timestamp.now(), actorType: 'customer', actorId: null, meta: {} }],
          createdAt: now,
          updatedAt: now,
        });
        tx.set(orderNumberRef, { orderId: orderRef.id, createdAt: now });
        tx.set(idempRef, { fingerprint, orderId: orderRef.id, orderNumber: candidateNumber, createdAt: now });

        return { ok: true, orderNumber: candidateNumber };
      });
      break;
    } catch (err) {
      if (err instanceof OrderNumberCollision) continue;
      throw err;
    }
  }

  if (!result) throw new Error('Could not generate a unique order number after several attempts.');
  if (!result.ok) return fail(result.status, result.error);

  return ok({ orderNumber: result.orderNumber });
});
