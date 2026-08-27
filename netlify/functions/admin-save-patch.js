/*
 * Admin: create or update a patch (upsert). Pass `id` in the body to
 * update; omit it to create.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb, admin } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { requireString, optionalString, requireNumber, requireBoolean, requireHex } = require('./_shared/validation');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const db = getDb();
  const id = body.id || null;

  const data = {
    name: requireString(body.name, 'Name', { maxLength: 60 }),
    description: optionalString(body.description, 'Description', { maxLength: 500 }),
    hex: requireHex(body.hex, 'Color'),
    price: requireNumber(body.price, 'Price', { min: 0 }),
    stockQty: requireNumber(body.stockQty, 'Stock', { min: 0, integer: true }),
    displayWidthPct: requireNumber(body.displayWidthPct, 'Display width', { min: 1, max: 100 }),
    displayHeightPct: requireNumber(body.displayHeightPct, 'Display height', { min: 1, max: 100 }),
    image: optionalString(body.image, 'Image', { maxLength: 300 }),
    active: requireBoolean(body.active ?? true, 'Active'),
  };

  const ref = id ? db.collection('patches').doc(id) : db.collection('patches').doc();
  const existingSnap = id ? await ref.get() : null;
  const existing = existingSnap && existingSnap.exists ? existingSnap.data() : null;

  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    ...data,
    createdAt: existing ? existing.createdAt : now,
    createdBy: existing ? existing.createdBy : auth.uid,
    updatedAt: now,
    updatedBy: auth.uid,
  });

  return ok({ id: ref.id });
});
