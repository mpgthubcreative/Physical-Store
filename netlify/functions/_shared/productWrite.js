/*
 * Shared product validation + transactional save, used by
 * admin-save-product.js. Kept out of that function file only because the
 * validation logic is long, not because it's reused elsewhere.
 *
 * SKU uniqueness is enforced via a top-level `skuIndex/{normalizedSku}`
 * collection (one doc per SKU, doc id = uppercased/trimmed SKU) rather than
 * scanning every product's embedded variants on every save. The product
 * document and its SKU index entries are written in ONE Firestore
 * transaction, so a save can never leave the index out of sync with the
 * product — either both succeed or neither does.
 */
const { admin } = require('./firebaseAdmin');
const {
  ValidationError,
  requireString,
  optionalString,
  requireNumber,
  requireBoolean,
  requirePercent,
  requireHex,
  requireArray,
  requireNoDuplicates,
} = require('./validation');

function normalizeSku(sku) {
  return String(sku).trim().toUpperCase();
}

function validateVariant(raw, index) {
  if (!raw || typeof raw !== 'object') throw new ValidationError(`Variant ${index + 1} is invalid.`);
  return {
    variantId: requireString(raw.variantId, `Variant ${index + 1} ID`, { maxLength: 60 }),
    name: requireString(raw.name, `Variant ${index + 1} name`, { maxLength: 80 }),
    hex: requireHex(raw.hex, `Variant ${index + 1} color`),
    sku: requireString(raw.sku, `Variant ${index + 1} SKU`, { maxLength: 40 }),
    stockQty: requireNumber(raw.stockQty, `Variant ${index + 1} stock`, { min: 0, integer: true }),
    lowStockThreshold: requireNumber(raw.lowStockThreshold ?? 5, `Variant ${index + 1} low-stock threshold`, {
      min: 0,
      integer: true,
    }),
    active: raw.active !== false,
    stageImage: optionalString(raw.stageImage, `Variant ${index + 1} stage image`, { maxLength: 300 }),
  };
}

function validateCustomizationConfig(raw, availablePatchIdsExist) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('customizationConfig is required for a customizable product.');

  const boundary = raw.boundary || {};
  const top = requirePercent(boundary.top, 'boundary.top');
  const left = requirePercent(boundary.left, 'boundary.left');
  const width = requirePercent(boundary.width, 'boundary.width');
  const height = requirePercent(boundary.height, 'boundary.height');
  if (top + height > 100.001) throw new ValidationError('boundary.top + boundary.height must not exceed 100.');
  if (left + width > 100.001) throw new ValidationError('boundary.left + boundary.width must not exceed 100.');

  const allowText = requireBoolean(raw.allowText ?? false, 'allowText');
  let textMaxLength = 0;
  let textPrice = 0;
  let textBoxSize = { width: 40, height: 12 };
  if (allowText) {
    textMaxLength = requireNumber(raw.textMaxLength, 'textMaxLength', { min: 1, max: 40, integer: true });
    textPrice = requireNumber(raw.textPrice, 'textPrice', { min: 0 });
    const box = raw.textBoxSize || {};
    textBoxSize = {
      width: requirePercent(box.width, 'textBoxSize.width'),
      height: requirePercent(box.height, 'textBoxSize.height'),
    };
  }

  const maxPatches = requireNumber(raw.maxPatches, 'maxPatches', { min: 0, max: 50, integer: true });
  const availablePatchIds = requireArray(raw.availablePatchIds || [], 'availablePatchIds', { maxLength: 50 });
  availablePatchIds.forEach((id) => requireString(id, 'availablePatchIds entry', { maxLength: 60 }));
  requireNoDuplicates(availablePatchIds, 'availablePatchIds');

  const unknown = availablePatchIds.filter((id) => !availablePatchIdsExist.has(id));
  if (unknown.length) {
    throw new ValidationError(`availablePatchIds references patches that don't exist: ${unknown.join(', ')}.`);
  }

  return { boundary: { top, left, width, height }, allowText, textMaxLength, textPrice, textBoxSize, maxPatches, availablePatchIds };
}

/**
 * Validates raw admin-submitted product input. `existingCollectionIds` and
 * `existingPatchIds` are Sets of real doc IDs from Firestore, used for
 * referential-integrity checks — callers fetch these before calling in.
 */
function validateProductInput(raw, { existingCollectionIds, existingPatchIds }) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Product payload is missing.');

  const title = requireString(raw.title, 'Title', { maxLength: 120 });
  const slug = requireString(raw.slug, 'Slug', { maxLength: 120 });
  const description = optionalString(raw.description, 'Description', { maxLength: 2000 });
  const category = optionalString(raw.category, 'Category', { maxLength: 60 });
  const basePrice = requireNumber(raw.basePrice, 'Base price', { min: 0 });
  const active = requireBoolean(raw.active ?? true, 'Active');
  const featured = requireBoolean(raw.featured ?? false, 'Featured');
  const badge = optionalString(raw.badge, 'Badge', { maxLength: 20 });
  const thumbnail = optionalString(raw.thumbnail, 'Thumbnail', { maxLength: 300 });
  const gallery = requireArray(raw.gallery || [], 'Gallery', { maxLength: 30 }).map((p, i) =>
    requireString(p, `Gallery image ${i + 1}`, { maxLength: 300 })
  );

  const collectionIds = requireArray(raw.collectionIds || [], 'Collection IDs', { maxLength: 20 });
  collectionIds.forEach((id) => requireString(id, 'Collection ID', { maxLength: 60 }));
  const unknownCollections = collectionIds.filter((id) => !existingCollectionIds.has(id));
  if (unknownCollections.length) {
    throw new ValidationError(`collectionIds references collections that don't exist: ${unknownCollections.join(', ')}.`);
  }

  const rawVariants = requireArray(raw.variants || [], 'Variants', { maxLength: 20 });
  if (rawVariants.length === 0) throw new ValidationError('At least one variant is required.');
  const variants = rawVariants.map(validateVariant);
  requireNoDuplicates(variants.map((v) => v.variantId), 'variant ID');
  requireNoDuplicates(variants.map((v) => normalizeSku(v.sku)), 'SKU (within this product)');

  const customizable = requireBoolean(raw.customizable ?? false, 'Customizable');
  const customizationConfig = customizable ? validateCustomizationConfig(raw.customizationConfig, existingPatchIds) : null;

  return {
    title,
    slug,
    description,
    category,
    basePrice,
    active,
    featured,
    badge,
    thumbnail,
    gallery,
    collectionIds,
    variants,
    customizable,
    customizationConfig,
  };
}

/**
 * Writes the product doc and maintains skuIndex/{sku} entries in one
 * transaction. Returns the product ID (new or existing).
 */
async function saveProductTransaction(db, { productId, data, actorUid }) {
  const productRef = productId ? db.collection('products').doc(productId) : db.collection('products').doc();

  await db.runTransaction(async (tx) => {
    // ---- reads first (Firestore transactions require all reads before any writes) ----
    const productSnap = productId ? await tx.get(productRef) : null;
    const existingData = productSnap && productSnap.exists ? productSnap.data() : null;

    const oldSkuMap = new Map((existingData?.variants || []).map((v) => [normalizeSku(v.sku), v.variantId]));
    const newSkuMap = new Map(data.variants.map((v) => [normalizeSku(v.sku), v.variantId]));

    const skusToRelease = [...oldSkuMap.keys()].filter((sku) => !newSkuMap.has(sku));
    const skusToClaim = [...newSkuMap.keys()].filter((sku) => !oldSkuMap.has(sku));

    const claimChecks = await Promise.all(
      skusToClaim.map((sku) => tx.get(db.collection('skuIndex').doc(sku)))
    );
    claimChecks.forEach((snap, i) => {
      if (snap.exists && snap.data().productId !== productRef.id) {
        throw new ValidationError(`SKU "${data.variants.find((v) => normalizeSku(v.sku) === skusToClaim[i]).sku}" is already used by another product.`);
      }
    });

    // ---- writes ----
    skusToRelease.forEach((sku) => tx.delete(db.collection('skuIndex').doc(sku)));
    skusToClaim.forEach((sku) => {
      const variantId = newSkuMap.get(sku);
      const variant = data.variants.find((v) => v.variantId === variantId);
      tx.set(db.collection('skuIndex').doc(sku), {
        sku: variant.sku,
        productId: productRef.id,
        variantId,
      });
    });

    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.set(productRef, {
      ...data,
      createdAt: existingData ? existingData.createdAt : now,
      createdBy: existingData ? existingData.createdBy : actorUid,
      updatedAt: now,
      updatedBy: actorUid,
    });
  });

  return productRef.id;
}

/** Releases every SKU this product owns — used by admin-delete-product.js. */
async function releaseAllSkusForProduct(db, productId) {
  const snap = await db.collection('skuIndex').where('productId', '==', productId).get();
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

module.exports = { normalizeSku, validateProductInput, saveProductTransaction, releaseAllSkusForProduct };
