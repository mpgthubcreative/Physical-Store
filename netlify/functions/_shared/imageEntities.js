/*
 * Maps (entityType, role) -> Storage path + the Firestore write needed to
 * attach/detach that image, shared by admin-request-image-upload.js,
 * admin-finalize-image-upload.js, and admin-remove-image.js so all three
 * agree on the same roles and paths.
 *
 * Roles: product -> "thumbnail" | "gallery" | "stageImage" (stageImage
 * requires variantId); patch -> "image"; collection -> "image".
 */
const { admin, getDb } = require('./firebaseAdmin');
const { ValidationError, requireString } = require('./validation');

const COLLECTION_BY_ENTITY = { product: 'products', patch: 'patches', collection: 'collections' };

function sanitizeFilename(filename) {
  const base = String(filename).split(/[/\\]/).pop() || 'image';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
}

function validateEntityType(entityType) {
  if (!COLLECTION_BY_ENTITY[entityType]) {
    throw new ValidationError(`Invalid entityType "${entityType}". Must be product, patch, or collection.`);
  }
  return entityType;
}

function validateRole(entityType, role, variantId) {
  if (entityType === 'product') {
    if (!['thumbnail', 'gallery', 'stageImage'].includes(role)) {
      throw new ValidationError('Product image role must be thumbnail, gallery, or stageImage.');
    }
    if (role === 'stageImage' && !variantId) {
      throw new ValidationError('variantId is required for a stageImage upload.');
    }
  } else if (role !== 'image') {
    throw new ValidationError(`${entityType} image role must be "image".`);
  }
  return role;
}

/** Confirms the entity (and variant, for stageImage) actually exists before issuing an upload URL. */
async function loadEntityForImage({ entityType, entityId, role, variantId }) {
  const db = getDb();
  const ref = db.collection(COLLECTION_BY_ENTITY[entityType]).doc(entityId);
  const snap = await ref.get();
  if (!snap.exists) throw new ValidationError(`${entityType} "${entityId}" not found.`);

  if (entityType === 'product' && role === 'stageImage') {
    const variants = snap.data().variants || [];
    if (!variants.some((v) => v.variantId === variantId)) {
      throw new ValidationError(`Variant "${variantId}" not found on this product.`);
    }
  }
  return { ref, snap };
}

function buildImagePath({ entityType, entityId, role, variantId, filename }) {
  const safeName = sanitizeFilename(filename);
  const stamp = Date.now();
  if (entityType === 'product') {
    if (role === 'stageImage') return `product-images/${entityId}/variants/${requireString(variantId, 'variantId', { maxLength: 60 })}-${stamp}-${safeName}`;
    if (role === 'gallery') return `product-images/${entityId}/gallery-${stamp}-${safeName}`;
    return `product-images/${entityId}/thumbnail-${stamp}-${safeName}`;
  }
  if (entityType === 'patch') return `patch-images/${entityId}/${stamp}-${safeName}`;
  return `collection-images/${entityId}/${stamp}-${safeName}`;
}

async function attachImage({ entityType, entityId, role, variantId, path, actorUid }) {
  const db = getDb();
  const collectionName = COLLECTION_BY_ENTITY[entityType];
  const ref = db.collection(collectionName).doc(entityId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  if (entityType === 'product' && role === 'stageImage') {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ValidationError('Product not found.');
      const variants = (snap.data().variants || []).map((v) => (v.variantId === variantId ? { ...v, stageImage: path } : v));
      tx.update(ref, { variants, updatedAt: now, updatedBy: actorUid });
    });
    return;
  }
  if (entityType === 'product' && role === 'gallery') {
    await ref.update({ gallery: admin.firestore.FieldValue.arrayUnion(path), updatedAt: now, updatedBy: actorUid });
    return;
  }
  if (entityType === 'product' && role === 'thumbnail') {
    await ref.update({ thumbnail: path, updatedAt: now, updatedBy: actorUid });
    return;
  }
  // patch/collection "image"
  await ref.update({ image: path, updatedAt: now, updatedBy: actorUid });
}

async function detachImage({ entityType, entityId, role, variantId, path, actorUid }) {
  const db = getDb();
  const collectionName = COLLECTION_BY_ENTITY[entityType];
  const ref = db.collection(collectionName).doc(entityId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  if (entityType === 'product' && role === 'stageImage') {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const variants = (snap.data().variants || []).map((v) => (v.variantId === variantId ? { ...v, stageImage: '' } : v));
      tx.update(ref, { variants, updatedAt: now, updatedBy: actorUid });
    });
    return;
  }
  if (entityType === 'product' && role === 'gallery') {
    await ref.update({ gallery: admin.firestore.FieldValue.arrayRemove(path), updatedAt: now, updatedBy: actorUid });
    return;
  }
  if (entityType === 'product' && role === 'thumbnail') {
    await ref.update({ thumbnail: '', updatedAt: now, updatedBy: actorUid });
    return;
  }
  await ref.update({ image: '', updatedAt: now, updatedBy: actorUid });
}

module.exports = {
  COLLECTION_BY_ENTITY,
  validateEntityType,
  validateRole,
  loadEntityForImage,
  buildImagePath,
  attachImage,
  detachImage,
};
