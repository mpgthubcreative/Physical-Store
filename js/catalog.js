/**
 * Catalog page: filtering + sorting over BuddyProducts.getAll().
 * Data source is swappable later (Firestore) without touching this file's
 * render/filter/sort logic — it only ever talks to BuddyProducts' async API.
 */
(function () {
  let allProducts = [];
  const state = {
    inStock: true,
    outOfStock: true,
    priceFrom: null,
    priceTo: null,
    sort: 'featured',
  };

  function applyFilters(products) {
    return products.filter((p) => {
      if (p.inStock && !state.inStock) return false;
      if (!p.inStock && !state.outOfStock) return false;
      if (state.priceFrom != null && p.price < state.priceFrom) return false;
      if (state.priceTo != null && p.price > state.priceTo) return false;
      return true;
    });
  }

  function applySort(products) {
    const list = products.slice();
    switch (state.sort) {
      case 'price-asc':
        return list.sort((a, b) => a.price - b.price);
      case 'price-desc':
        return list.sort((a, b) => b.price - a.price);
      case 'name-asc':
        return list.sort((a, b) => a.name.localeCompare(b.name));
      default:
        return list; // "featured" = catalog's natural order
    }
  }

  function render() {
    const grid = document.querySelector('[data-catalog-grid]');
    const count = document.querySelector('[data-catalog-count]');
    const visible = applySort(applyFilters(allProducts));

    count.textContent = visible.length + ' product' + (visible.length === 1 ? '' : 's');
    grid.innerHTML = visible.length
      ? visible.map(window.BuddyProductCard.render).join('')
      : '<div class="catalog-empty">No products match those filters.</div>';
  }

  function wireFilters() {
    document.querySelector('[data-filter-instock]').addEventListener('change', (e) => {
      state.inStock = e.target.checked;
      render();
    });
    document.querySelector('[data-filter-oos]').addEventListener('change', (e) => {
      state.outOfStock = e.target.checked;
      render();
    });
    document.querySelector('[data-price-from]').addEventListener('input', (e) => {
      state.priceFrom = e.target.value === '' ? null : Number(e.target.value);
      render();
    });
    document.querySelector('[data-price-to]').addEventListener('input', (e) => {
      state.priceTo = e.target.value === '' ? null : Number(e.target.value);
      render();
    });
    document.querySelector('[data-sort-select]').addEventListener('change', (e) => {
      state.sort = e.target.value;
      render();
    });
    document.querySelector('[data-filter-reset]').addEventListener('click', (e) => {
      e.preventDefault();
      state.inStock = true;
      state.outOfStock = true;
      state.priceFrom = null;
      state.priceTo = null;
      state.sort = 'featured';
      document.querySelector('[data-filter-instock]').checked = true;
      document.querySelector('[data-filter-oos]').checked = true;
      document.querySelector('[data-price-from]').value = '';
      document.querySelector('[data-price-to]').value = '';
      document.querySelector('[data-sort-select]').value = 'featured';
      render();
    });

    const panel = document.querySelector('[data-filter-panel]');
    document.querySelector('[data-filter-toggle]').addEventListener('click', () => {
      panel.classList.toggle('is-open');
    });
  }

  async function init() {
    BuddyNav.init('#site-nav', { active: 'shop' });
    BuddyFooter.init('#site-footer', { showNewsletter: false });
    BuddyCart.initDrawer();

    allProducts = await window.BuddyProducts.getAll();
    document.querySelector('[data-highest-price]').textContent = window.BuddyProducts.format(window.BuddyProducts.highestPrice());
    wireFilters();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
