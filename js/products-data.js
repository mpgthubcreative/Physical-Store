/**
 * BuddyProducts — thin fetch adapter over the public /api/catalog function.
 *
 * Phase 2 built this module as a static mock specifically so it could be
 * swapped for a real backend without touching home.js/catalog.js/product.js
 * — this is that swap. The public shape (async getAll/getFeatured/getBySlug,
 * sync highestPrice/format) is unchanged.
 */
(function () {
  let cache = null; // the full active-product list for this page load

  async function fetchAll() {
    if (cache) return cache;
    const res = await fetch('/api/catalog');
    if (!res.ok) throw new Error('Failed to load catalog.');
    const data = await res.json();
    cache = data.products;
    return cache;
  }

  function fmt(n) {
    return '₱' + Number(n).toLocaleString('en-PH') + '.00';
  }

  async function getAll() {
    return fetchAll();
  }

  async function getFeatured(count) {
    const all = await fetchAll();
    return all.filter((p) => p.featured).slice(0, count || 5);
  }

  async function getBySlug(slug) {
    const all = await fetchAll();
    return all.find((p) => p.slug === slug) || null;
  }

  /** Sync by design — every call site awaits getAll()/getFeatured() first, so the cache is always already populated. */
  function highestPrice() {
    if (!cache || !cache.length) return 0;
    return Math.max(...cache.map((p) => p.price));
  }

  window.BuddyProducts = { getAll, getFeatured, getBySlug, highestPrice, format: fmt };
})();
