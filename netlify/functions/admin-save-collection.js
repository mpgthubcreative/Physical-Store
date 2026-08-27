/*
 * Admin: create or update a collection (upsert). Pass `id` to update.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb, admin } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireString, optionalString, requireNumber, requireBoolean, slugify } = require('./_shared/validation');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const db = getDb();
  const id = body.id || null;

  if (!body.slug && body.name) body.slug = slugify(body.name);

  const data = {
    name: requireString(body.name, 'Name', { maxLength: 80 }),
    slug: requireString(body.slug, 'Slug', { maxLength: 80 }),
    description: optionalString(body.description, 'Description', { maxLength: 500 }),
    image: optionalString(body.image, 'Image', { maxLength: 300 }),
    active: requireBoolean(body.active ?? true, 'Active'),
    featured: requireBoolean(body.featured ?? false, 'Featured'),
    sortOrder: requireNumber(body.sortOrder ?? 0, 'Sort order', { integer: true }),
  };

  const slugMatch = await db.collection('collections').where('slug', '==', data.slug).limit(2).get();
  if (slugMatch.docs.some((d) => d.id !== id)) {
    throw new ValidationError(`Slug "${data.slug}" is already in use by another collection.`);
  }

  const ref = id ? db.collection('collections').doc(id) : db.collection('collections').doc();
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
