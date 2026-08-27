import { apiFetch } from './admin-auth.js';

/**
 * Full direct-upload flow shared by products.js/patches.js/collections.js:
 * request a signed URL, PUT the file straight to Storage, then finalize.
 * Returns { path, url }.
 */
export async function uploadImage(file, { entityType, entityId, role, variantId }) {
  const { uploadUrl, path, contentType } = await apiFetch('/api/admin-request-image-upload', {
    method: 'POST',
    body: JSON.stringify({ entityType, entityId, role, variantId, filename: file.name, contentType: file.type, sizeBytes: file.size }),
  });

  const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
  if (!putRes.ok) throw new Error('Upload to storage failed.');

  return apiFetch('/api/admin-finalize-image-upload', {
    method: 'POST',
    body: JSON.stringify({ entityType, entityId, role, variantId, path }),
  });
}

export async function removeImage({ entityType, entityId, role, variantId, path }) {
  return apiFetch('/api/admin-remove-image', {
    method: 'POST',
    body: JSON.stringify({ entityType, entityId, role, variantId, path }),
  });
}
