/*
 * Admin: create or update a product (upsert). Pass `id` in the body to
 * update an existing product; omit it to create a new one.
 *
 * Full server-side validation + transactional SKU-index maintenance live in
 * _shared/productWrite.js — this file just wires auth, loads the reference
 * data needed for validation, and calls it.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, slugify, optionalString } = require('./_shared/validation');
const { validateProductInput, saveProductTransaction } = require('./_shared/productWrite');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return fail(400, 'Invalid JSON body.');
  }

  const db = getDb();
  const productId = body.id || null;

  if (!body.slug && body.title) body.slug = slugify(body.title);

  const [collectionsSnap, patchesSnap] = await Promise.all([
    db.collection('collections').get(),
    db.collection('patches').get(),
  ]);
  const existingCollectionIds = new Set(collectionsSnap.docs.map((d) => d.id));
  const existingPatchIds = new Set(patchesSnap.docs.map((d) => d.id));

  const data = validateProductInput(body, { existingCollectionIds, existingPatchIds });

  // Slug uniqueness (excluding this product itself when updating).
  const slugMatch = await db.collection('products').where('slug', '==', data.slug).limit(2).get();
  const slugTaken = slugMatch.docs.some((d) => d.id !== productId);
  if (slugTaken) throw new ValidationError(`Slug "${data.slug}" is already in use by another product.`);

  const stockAdjustmentReason = optionalString(body.stockAdjustmentReason, 'Stock adjustment reason', { maxLength: 300 });
  const id = await saveProductTransaction(db, { productId, data, actorUid: auth.uid, stockAdjustmentReason });
  return ok({ id });
});
