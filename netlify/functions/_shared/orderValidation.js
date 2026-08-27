/*
 * Resolves a browser-submitted cart into server-priced, server-validated
 * order lines. Nothing about price, stock, or configuration is ever
 * trusted from the browser — every line is re-checked against a fresh
 * Firestore read of the current product/variant/patch/customizationConfig.
 *
 * Two-pass validation, deliberately in this order:
 *   Pass 1 — per line: does the product/variant/patch/customization even
 *            exist and is it currently valid? While doing this, accumulate
 *            AGGREGATE demand across the whole cart (not per line) for
 *            every distinct variant and every distinct patch — two lines
 *            using the same variant, or a patch used many times across
 *            different lines, must sum before being checked against stock.
 *   Pass 2 — aggregate stock check: total demand per variant/patch vs its
 *            current stockQty. This intentionally happens only after every
 *            line has passed pass 1, so a stock failure always reports
 *            against the whole-cart total, never a per-line total that
 *            could pass while the combined cart oversells.
 *
 * This performs plain (non-transactional) reads — same as Luna's proven
 * create-order.js. Wrapping this in the order-creation transaction would
 * add no real protection against overselling in Phase 5C (nothing writes
 * to stockQty yet — that's Phase 5D's reservation system), so the
 * simplicity of a read-then-transact flow is preferred, matching Luna's
 * precedent. The residual race window between this read and the order
 * write is an explicitly accepted Phase 5C limitation.
 */
const { getDb } = require('./firebaseAdmin');
const { requireString, requireNumber } = require('./validation');

const MAX_LINES = 20;
const MAX_QTY_PER_LINE = 20;

/*
 * A missing/non-numeric stockQty must be treated as ZERO available, never
 * as "unlimited" — Number(undefined) is NaN, and every `NaN < demand`
 * comparison is false, which would silently let every order through
 * regardless of demand. This was caught live: patches created before
 * stockQty existed on the schema have no such field at all.
 */
function safeStock(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

class CartInvalidError extends Error {
  constructor(reason, lineIndex, message) {
    super(message || reason);
    this.name = 'CartInvalidError';
    this.reason = reason;
    this.lineIndex = lineIndex === undefined ? null : lineIndex;
  }
}

async function resolveAndValidateCart(rawItems, dbArg) {
  const db = dbArg || getDb();

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new CartInvalidError('EMPTY_CART', null, 'Your cart is empty.');
  }
  if (rawItems.length > MAX_LINES) {
    throw new CartInvalidError('MALFORMED', null, 'Your cart has too many items.');
  }

  const variantDemand = new Map(); // `${productId}::${variantId}` -> total quantity
  const patchDemand = new Map(); // patchId -> total instances (each weighted by its line's quantity)
  const productCache = new Map();
  const patchCache = new Map();
  const structuralLines = [];

  // ---- Pass 1: structural validation + demand accumulation ----
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    if (!raw || typeof raw !== 'object') throw new CartInvalidError('MALFORMED', i, 'Cart item is invalid.');

    const productId = requireString(raw.productId, 'productId', { maxLength: 100 });
    const variantId = requireString(raw.variantId, 'variantId', { maxLength: 100 });
    const quantity = requireNumber(raw.quantity, 'quantity', { min: 1, max: MAX_QTY_PER_LINE, integer: true });

    let product = productCache.get(productId);
    if (!product) {
      const snap = await db.collection('products').doc(productId).get();
      if (!snap.exists) throw new CartInvalidError('PRODUCT_NOT_FOUND', i, 'A product in your cart no longer exists.');
      product = { id: snap.id, ...snap.data() };
      productCache.set(productId, product);
    }
    if (product.active !== true) throw new CartInvalidError('PRODUCT_INACTIVE', i, `"${product.title}" is no longer available.`);

    const variant = (product.variants || []).find((v) => v.variantId === variantId);
    if (!variant) throw new CartInvalidError('VARIANT_NOT_FOUND', i, 'A selected color is no longer available.');
    if (variant.active !== true) throw new CartInvalidError('VARIANT_INACTIVE', i, `"${variant.name}" is no longer available.`);

    let personalization = null;
    const patchInstances = [];

    const rawPatches = Array.isArray(raw.patches) ? raw.patches : [];
    const rawPersonalization = raw.personalization || null;

    if (rawPersonalization || rawPatches.length > 0) {
      if (product.customizable !== true || !product.customizationConfig) {
        throw new CartInvalidError('CONFIG_CHANGED', i, `"${product.title}" is no longer customizable.`);
      }
      const config = product.customizationConfig;

      if (rawPersonalization) {
        if (!config.allowText) throw new CartInvalidError('CONFIG_CHANGED', i, 'Personalization is no longer available for this product.');
        const text = requireString(rawPersonalization.text, 'Personalization text', { maxLength: config.textMaxLength });
        const x = requireNumber(rawPersonalization.x, 'Text x', { min: 0, max: 100 });
        const y = requireNumber(rawPersonalization.y, 'Text y', { min: 0, max: 100 });
        const z = requireNumber(rawPersonalization.z, 'Text z', { min: 0, max: 100000, integer: true });
        personalization = { text, x, y, z };
      }

      if (rawPatches.length > config.maxPatches) {
        throw new CartInvalidError('CONFIG_CHANGED', i, `This design uses more patches than currently allowed (max ${config.maxPatches}).`);
      }

      for (const rawPatch of rawPatches) {
        const patchId = requireString(rawPatch && rawPatch.patchId, 'patchId', { maxLength: 100 });
        if (!config.availablePatchIds.includes(patchId)) {
          throw new CartInvalidError('PATCH_INACTIVE', i, 'One of the selected patches is no longer available for this product.');
        }
        const x = requireNumber(rawPatch.x, 'Patch x', { min: 0, max: 100 });
        const y = requireNumber(rawPatch.y, 'Patch y', { min: 0, max: 100 });
        const z = requireNumber(rawPatch.z, 'Patch z', { min: 0, max: 100000, integer: true });

        let patch = patchCache.get(patchId);
        if (!patch) {
          const psnap = await db.collection('patches').doc(patchId).get();
          if (!psnap.exists) throw new CartInvalidError('PATCH_INACTIVE', i, 'One of the selected patches no longer exists.');
          patch = { id: psnap.id, ...psnap.data() };
          patchCache.set(patchId, patch);
        }
        if (patch.active !== true) throw new CartInvalidError('PATCH_INACTIVE', i, `"${patch.name}" is no longer available.`);

        patchInstances.push({ patchId, x, y, z, patch });
        // Weighted by this LINE's quantity — e.g. Heart x3 on a line ordered
        // qty 2 contributes 2 to this instance's count, and there are 3 such
        // instances on the line, so Heart's total demand gets +6 overall.
        patchDemand.set(patchId, (patchDemand.get(patchId) || 0) + quantity);
      }
    }

    const vKey = `${productId}::${variantId}`;
    variantDemand.set(vKey, (variantDemand.get(vKey) || 0) + quantity);

    structuralLines.push({ index: i, productId, variantId, quantity, product, variant, personalization, patchInstances });
  }

  // ---- Pass 2: aggregate stock validation (whole-cart totals, not per-line) ----
  for (const line of structuralLines) {
    const vKey = `${line.productId}::${line.variantId}`;
    const demand = variantDemand.get(vKey);
    if (safeStock(line.variant.stockQty) < demand) {
      throw new CartInvalidError('OUT_OF_STOCK', line.index, `Not enough stock for "${line.product.title} — ${line.variant.name}".`);
    }
  }
  for (const [patchId, demand] of patchDemand) {
    const patch = patchCache.get(patchId);
    if (safeStock(patch.stockQty) < demand) {
      throw new CartInvalidError('OUT_OF_STOCK', null, `Not enough stock for the patch "${patch.name}".`);
    }
  }

  // ---- Pricing + historical snapshot ----
  const lines = structuralLines.map(buildLineSnapshot);
  const subtotal = lines.reduce((sum, l) => sum + l.pricing.lineTotal, 0);

  return { lines, subtotal };
}

function buildLineSnapshot(line) {
  const { product, variant, quantity, personalization, patchInstances } = line;
  const config = product.customizationConfig || null;

  const textFee = personalization ? Number(config.textPrice || 0) : 0;
  const patchesFee = patchInstances.reduce((sum, p) => sum + Number(p.patch.price || 0), 0);
  // Buddy's current product schema has no per-variant price delta — every
  // variant of a product shares basePrice. Modeled explicitly (as 0) so the
  // snapshot shape already has a place for this if that ever changes.
  const variantAdjustment = 0;
  const basePrice = Number(product.basePrice || 0);
  const unitPrice = basePrice + variantAdjustment + textFee + patchesFee;
  const lineTotal = unitPrice * quantity;

  return {
    productId: product.id,
    productName: product.title,
    variantId: variant.variantId,
    variantName: variant.name,
    sku: variant.sku,
    quantity,
    pricing: { basePrice, variantAdjustment, textFee, patchesFee, unitPrice, lineTotal },
    customization: config
      ? {
          rendererVersion: 1,
          boundary: { top: config.boundary.top, left: config.boundary.left, width: config.boundary.width, height: config.boundary.height },
          variant: { hex: variant.hex, stageImagePath: variant.stageImage || null },
          text: personalization
            ? {
                value: personalization.text,
                x: personalization.x,
                y: personalization.y,
                z: personalization.z,
                boxWidthPct: config.textBoxSize ? config.textBoxSize.width : null,
                boxHeightPct: config.textBoxSize ? config.textBoxSize.height : null,
              }
            : null,
          patches: patchInstances.map((p) => ({
            patchId: p.patchId,
            patchName: p.patch.name,
            x: p.x,
            y: p.y,
            z: p.z,
            widthPct: p.patch.displayWidthPct,
            heightPct: p.patch.displayHeightPct,
            imagePath: p.patch.image || null,
            hex: p.patch.hex,
            price: Number(p.patch.price || 0),
          })),
        }
      : null,
    thumbnailImagePath: product.thumbnail || null,
  };
}

module.exports = { resolveAndValidateCart, CartInvalidError, MAX_LINES, MAX_QTY_PER_LINE };
