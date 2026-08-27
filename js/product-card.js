/**
 * BuddyProductCard — one card renderer shared by Home's featured grid and
 * the Catalog grid (and later the product page's "You may also like").
 * No real photography yet, so the image slot renders a labeled placeholder
 * in the same panel color the mockup uses for its image-slot components.
 */
(function () {
  function render(product) {
    return `
      <a class="card product-card" href="product.html?slug=${encodeURIComponent(product.slug)}" data-product-slug="${product.slug}">
        <div class="product-card__image">
          <span class="placeholder-label">${product.name}</span>
          ${product.badge ? `<span class="badge-coral product-card__badge">${product.badge}</span>` : ''}
        </div>
        <div class="product-card__body">
          <h4 class="card-title">${product.name}</h4>
          <div class="price">${product.priceLabel}</div>
        </div>
      </a>`;
  }

  window.BuddyProductCard = { render };
})();
