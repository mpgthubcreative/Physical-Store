/**
 * BuddyProducts — static mock catalog for Phase 2.
 *
 * The read shape (async getAll/getFeatured/getBySlug returning plain product
 * objects) is deliberately the same shape a Firestore-backed version would
 * return, so catalog.js/home.js never need to change when this module is
 * later swapped for real reads — only this file's internals change.
 */
(function () {
  const PRODUCTS = [
    { id: 'pouch', slug: 'everyday-pouch', name: 'Everyday Pouch', price: 260, badge: null, inStock: true },
    { id: 'bagtag', slug: 'bag-tag', name: 'Bag Tag', price: 120, badge: null, inStock: true },
    { id: 'pencil', slug: 'pencil-case', name: 'Pencil Case', price: 320, badge: null, inStock: true },
    { id: 'coin', slug: 'coin-purse', name: 'Coin Purse', price: 190, badge: null, inStock: true },
    { id: 'box', slug: 'patch-box', name: 'Patch Box', price: 790, badge: 'COMBO', inStock: true, priceLabel: 'From ₱790.00' },
    { id: 'tote', slug: 'mini-tote', name: 'Mini Tote', price: 340, badge: 'NEW', inStock: false },
  ];

  function fmt(n) {
    return '₱' + Number(n).toLocaleString('en-PH') + '.00';
  }

  function withLabel(p) {
    return { ...p, priceLabel: p.priceLabel || fmt(p.price) };
  }

  async function getAll() {
    return PRODUCTS.map(withLabel);
  }

  async function getFeatured(count) {
    return PRODUCTS.slice(0, count || 5).map(withLabel);
  }

  async function getBySlug(slug) {
    const found = PRODUCTS.find((p) => p.slug === slug);
    return found ? withLabel(found) : null;
  }

  function highestPrice() {
    return Math.max(...PRODUCTS.map((p) => p.price));
  }

  window.BuddyProducts = { getAll, getFeatured, getBySlug, highestPrice, format: fmt };
})();
