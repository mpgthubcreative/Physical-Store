/*
 * Public, unauthenticated catalog read. This is the ONLY way the storefront
 * reads product/patch/collection data — Firestore rules stay deny-all, and
 * this function only ever reads `active: true` documents.
 *
 * Two modes:
 *   GET /api/catalog            -> { products: [...] }         (Home/Catalog)
 *   GET /api/catalog?slug=x     -> { product: {...} } | 404     (Product page)
 *
 * Response shapes intentionally match what js/products-data.js and
 * js/product-detail-data.js already return today (Phase 2/3 static mocks),
 * so home.js/catalog.js/product.js/customizer.js need no changes — see
 * those two files for the thin fetch adapters that now call this instead.
 */
const { getDb, admin } = require('./_shared/firebaseAdmin');
const { publicUrl } = require('./_shared/publicUrl');
const { availableQty } = require('./_shared/inventory');

function fmt(n) {
  return '₱' + Number(n).toLocaleString('en-PH') + '.00';
}

// Phase 5D: availability is stockQty - reservedQty, never raw stockQty — a
// variant can be fully "in stock" yet fully spoken for by other customers'
// active reservations. Only inStock (boolean) is ever exposed publicly;
// exact stock/reserved counts stay internal.
function productInStock(product) {
  return (product.variants || []).some((v) => v.active !== false && availableQty(v) > 0);
}

function toCardShape(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    slug: d.slug,
    name: d.title,
    price: d.basePrice,
    priceLabel: d.badge === 'COMBO' ? `From ${fmt(d.basePrice)}` : fmt(d.basePrice),
    badge: d.badge || null,
    inStock: productInStock(d),
    featured: !!d.featured,
    thumbnailUrl: publicUrl(d.thumbnail),
  };
}

async function handleList(db, res) {
  const snap = await db.collection('products').where('active', '==', true).get();
  const products = snap.docs.map(toCardShape);
  return res(200, { products });
}

async function handleDetail(db, slug, res) {
  const snap = await db.collection('products').where('active', '==', true).where('slug', '==', slug).limit(1).get();
  if (snap.empty) return res(404, { error: 'Product not found.' });

  const doc = snap.docs[0];
  const d = doc.data();

  let customizationConfig;
  if (d.customizable && d.customizationConfig) {
    const ids = d.customizationConfig.availablePatchIds || [];
    let availablePatches = [];
    if (ids.length) {
      // Firestore documentId() 'in' queries cap at 30 — fine at this scale;
      // a product offering more than 30 distinct patches would need batching.
      // active is filtered in memory rather than as a second query clause,
      // to avoid depending on a composite index existing for this pairing.
      const patchSnap = await db
        .collection('patches')
        .where(admin.firestore.FieldPath.documentId(), 'in', ids.slice(0, 30))
        .get();
      availablePatches = patchSnap.docs
        .filter((p) => p.data().active !== false)
        .map((p) => {
          const pd = p.data();
          return { id: p.id, name: pd.name, hex: pd.hex, price: pd.price, width: pd.displayWidthPct, height: pd.displayHeightPct, imageUrl: publicUrl(pd.image) };
        });
    }
    customizationConfig = {
      boundary: d.customizationConfig.boundary,
      allowText: d.customizationConfig.allowText,
      textMaxLength: d.customizationConfig.textMaxLength,
      textPrice: d.customizationConfig.textPrice,
      textBoxSize: d.customizationConfig.textBoxSize,
      maxPatches: d.customizationConfig.maxPatches,
      availablePatches,
    };
  }

  const product = {
    id: doc.id,
    slug: d.slug,
    name: d.title,
    basePrice: d.basePrice,
    description: d.description || '',
    variants: (d.variants || [])
      .filter((v) => v.active !== false)
      .map((v) => ({ id: v.variantId, name: v.name, hex: v.hex, stageImageUrl: publicUrl(v.stageImage) })),
    customizationConfig,
  };

  return res(200, { product });
}

exports.handler = async (event) => {
  const respond = (statusCode, body) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Public product data: safe to cache briefly at the CDN edge; the
      // browser itself always revalidates, so a catalog edit is never more
      // than ~30s stale for a shopper.
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
    },
    body: JSON.stringify(body),
  });

  try {
    const db = getDb();
    const slug = (event.queryStringParameters || {}).slug;
    if (slug) return await handleDetail(db, slug, respond);
    return await handleList(db, respond);
  } catch (err) {
    console.error('catalog.js error:', err);
    return respond(500, { error: 'Could not load the catalog right now.' });
  }
};
