/**
 * BuddyProductCard — one card renderer shared by Home's featured grid, the
 * Catalog grid, and the product page's "You may also like". Shows the
 * admin-uploaded thumbnail when one exists; falls back to the labeled
 * placeholder (the mockup's image-slot look) for products that don't have
 * one yet — never a broken image icon.
 */
(function () {
  function render(product) {
    const media = product.thumbnailUrl
      ? `<img class="product-card__photo" src="${product.thumbnailUrl}" alt="${product.name}" loading="lazy" />`
      : `<span class="placeholder-label">${product.name}</span>`;

    return `
      <a class="card product-card" href="product.html?slug=${encodeURIComponent(product.slug)}" data-product-slug="${product.slug}">
        <div class="product-card__image">
          ${media}
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
