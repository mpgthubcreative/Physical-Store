/** Home page: nav/footer + featured products grid. */
(function () {
  async function renderFeatured() {
    const grid = document.querySelector('[data-featured-grid]');
    if (!grid) return;
    const products = await window.BuddyProducts.getFeatured(5);
    grid.innerHTML = products.map(window.BuddyProductCard.render).join('');
  }

  document.addEventListener('DOMContentLoaded', () => {
    BuddyNav.init('#site-nav', { active: 'home' });
    BuddyFooter.init('#site-footer', { showNewsletter: true });
    BuddyCart.initDrawer();
    renderFeatured();
  });
})();
