/*
 * Admin: create or update a patch (upsert). Pass `id` in the body to
 * update; omit it to create.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb, admin } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireString, optionalString, requireNumber, requireBoolean, requireHex } = require('./_shared/validation');

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

  // Phase 5D correction #8: reservedQty is server-controlled, never trusted
  // from the browser (the form above never even collects it). Re-attached
  // from the existing document here so a save can never silently drop it.
  const existingReservedQtyNum = Number(existing && existing.reservedQty);
  const reservedQty = Number.isFinite(existingReservedQtyNum) ? existingReservedQtyNum : 0;
  if (data.stockQty < reservedQty) {
    throw new ValidationError(`Stock (${data.stockQty}) cannot be less than the reserved quantity (${reservedQty}).`);
  }

  // Inventory audit trail: a manual stock change on an EXISTING patch
  // requires a reason and gets one inventoryAdjustments/{id} entry. A
  // brand-new patch's initial stock isn't an "adjustment".
  const existingStockNum = existing ? Number(existing.stockQty) : null;
  const existingStock = Number.isFinite(existingStockNum) ? existingStockNum : 0;
  const stockChanged = existing && data.stockQty !== existingStock;
  const stockAdjustmentReason = optionalString(body.stockAdjustmentReason, 'Stock adjustment reason', { maxLength: 300 });
  if (stockChanged && !stockAdjustmentReason) {
    throw new ValidationError('A reason is required when changing stock quantity.');
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    ...data,
    reservedQty,
    createdAt: existing ? existing.createdAt : now,
    createdBy: existing ? existing.createdBy : auth.uid,
    updatedAt: now,
    updatedBy: auth.uid,
  });

  if (stockChanged) {
    await db.collection('inventoryAdjustments').doc().set({
      resourceType: 'patch',
      patchId: ref.id,
      previousStockQty: existingStock,
      newStockQty: data.stockQty,
      delta: data.stockQty - existingStock,
      reason: stockAdjustmentReason,
      adjustedBy: auth.uid,
      adjustedAt: now,
    });
  }

  return ok({ id: ref.id });
});
