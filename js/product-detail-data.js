/**
 * BuddyProductDetail — thin fetch adapter over /api/catalog?slug=... .
 *
 * Same swap as products-data.js: the customizer engine and product.js only
 * ever call getBySlug() and read product.customizationConfig — nothing
 * about how that data arrives changed, only where it comes from.
 */
(function () {
  const cache = new Map();

  async function getBySlug(slug) {
    if (cache.has(slug)) return cache.get(slug);
    const res = await fetch('/api/catalog?slug=' + encodeURIComponent(slug));
    if (res.status === 404) {
      cache.set(slug, null);
      return null;
    }
    if (!res.ok) throw new Error('Failed to load product.');
    const data = await res.json();
    cache.set(slug, data.product);
    return data.product;
  }

  window.BuddyProductDetail = { getBySlug };
})();
