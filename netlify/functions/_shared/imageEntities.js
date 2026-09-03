/*
 * Maps (entityType, role) -> Storage path + the Firestore write needed to
 * attach/detach that image, shared by admin-request-image-upload.js,
 * admin-finalize-image-upload.js, and admin-remove-image.js so all three
 * agree on the same roles and paths.
 *
 * Roles: product -> "thumbnail" | "gallery" | "stageImage" (stageImage
 * requires variantId); patch -> "image"; collection -> "image";
 * settings -> "gcashQr" | "bankQr" (Phase 5D.2 payment QR codes).
 *
 * Phase 5D.2 adds the `settings` entity so payment QR images reuse this
 * exact pipeline — signed direct-to-Storage upload, server-side existence/
 * type/size verification, path stored in Firestore, URL derived on read —
 * rather than introducing a second upload mechanism. The only entity-
 * specific part is which document/field the path lands in.
 *
 * attachImage() returns { previousPath } so a caller replacing an image can
 * clean up the object it displaced only AFTER Firestore already points at
 * the new one — settings can therefore never be left pointing at a deleted
 * object (see admin-finalize-image-upload.js).
 */
const { admin, getDb } = require('./firebaseAdmin');
const { ValidationError, requireString } = require('./validation');

const COLLECTION_BY_ENTITY = { product: 'products', patch: 'patches', collection: 'collections', settings: 'settings' };

// settings/{docId} documents that may hold images, and which roles each
// allows. Keeps "settings" from becoming a write-anywhere entity type.
const SETTINGS_IMAGE_ROLES = { payment: { gcashQr: 'gcash', bankQr: 'bank' } };

function sanitizeFilename(filename) {
  const base = String(filename).split(/[/\\]/).pop() || 'image';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
}

function validateEntityType(entityType) {
  if (!COLLECTION_BY_ENTITY[entityType]) {
    throw new ValidationError(`Invalid entityType "${entityType}". Must be product, patch, collection, or settings.`);
  }
  return entityType;
}

function validateRole(entityType, role, variantId, entityId) {
  if (entityType === 'product') {
    if (!['thumbnail', 'gallery', 'stageImage'].includes(role)) {
      throw new ValidationError('Product image role must be thumbnail, gallery, or stageImage.');
    }
    if (role === 'stageImage' && !variantId) {
      throw new ValidationError('variantId is required for a stageImage upload.');
    }
  } else if (entityType === 'settings') {
    const allowed = SETTINGS_IMAGE_ROLES[entityId];
    if (!allowed) throw new ValidationError(`Settings document "${entityId}" does not hold images.`);
    if (!allowed[role]) {
      throw new ValidationError(`Settings image role must be one of: ${Object.keys(allowed).join(', ')}.`);
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

  // settings/payment legitimately may not exist yet on a store that has
  // never saved payment configuration — uploading a QR is allowed to be the
  // first write, so absence is not an error here (attachImage creates it
  // with merge). Every other entity must already exist.
  if (!snap.exists && entityType !== 'settings') {
    throw new ValidationError(`${entityType} "${entityId}" not found.`);
  }

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
  if (entityType === 'settings') return `settings-images/${entityId}/${role}-${stamp}-${safeName}`;
  return `collection-images/${entityId}/${stamp}-${safeName}`;
}

/**
 * Points the entity's Firestore field at `path`.
 *
 * Returns { previousPath } — the object this upload displaced, if any, so
 * the caller can delete it AFTER Firestore already references the new one.
 * Ordering matters: write first, delete second, so an interrupted replace
 * leaves an unreferenced orphan object (harmless) rather than a settings
 * document pointing at a deleted asset (a broken QR for every customer).
 */
async function attachImage({ entityType, entityId, role, variantId, path, actorUid }) {
  const db = getDb();
  const collectionName = COLLECTION_BY_ENTITY[entityType];
  const ref = db.collection(collectionName).doc(entityId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  if (entityType === 'settings') {
    const field = SETTINGS_IMAGE_ROLES[entityId][role];
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data() : {};
      const previousPath = (current[field] && current[field].qrImagePath) || null;
      // Nested merge — only touches <field>.qrImagePath, so enabled/
      // accountName/accountNumber and the legacy methods[] array are all
      // left exactly as they were.
      tx.set(ref, { [field]: { qrImagePath: path }, updatedAt: now, updatedBy: actorUid }, { merge: true });
      return { previousPath };
    });
  }

  if (entityType === 'product' && role === 'stageImage') {
    let previousPath = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ValidationError('Product not found.');
      const existing = (snap.data().variants || []).find((v) => v.variantId === variantId);
      previousPath = (existing && existing.stageImage) || null;
      const variants = (snap.data().variants || []).map((v) => (v.variantId === variantId ? { ...v, stageImage: path } : v));
      tx.update(ref, { variants, updatedAt: now, updatedBy: actorUid });
    });
    return { previousPath };
  }
  if (entityType === 'product' && role === 'gallery') {
    await ref.update({ gallery: admin.firestore.FieldValue.arrayUnion(path), updatedAt: now, updatedBy: actorUid });
    return { previousPath: null }; // gallery is additive — nothing is displaced
  }
  if (entityType === 'product' && role === 'thumbnail') {
    const snap = await ref.get();
    const previousPath = (snap.exists && snap.data().thumbnail) || null;
    await ref.update({ thumbnail: path, updatedAt: now, updatedBy: actorUid });
    return { previousPath };
  }
  // patch/collection "image"
  const snap = await ref.get();
  const previousPath = (snap.exists && snap.data().image) || null;
  await ref.update({ image: path, updatedAt: now, updatedBy: actorUid });
  return { previousPath };
}

async function detachImage({ entityType, entityId, role, variantId, path, actorUid }) {
  const db = getDb();
  const collectionName = COLLECTION_BY_ENTITY[entityType];
  const ref = db.collection(collectionName).doc(entityId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  if (entityType === 'settings') {
    const field = SETTINGS_IMAGE_ROLES[entityId][role];
    await ref.set({ [field]: { qrImagePath: null }, updatedAt: now, updatedBy: actorUid }, { merge: true });
    return;
  }

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
  SETTINGS_IMAGE_ROLES,
  validateEntityType,
  validateRole,
  loadEntityForImage,
  buildImagePath,
  attachImage,
  detachImage,
};
