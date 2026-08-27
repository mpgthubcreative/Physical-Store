/**
 * Product page bootstrap: loads a product by ?slug=. Customizable products
 * (customizationConfig present) get the full live customizer engine;
 * non-customizable products get a plain variant-swatch image viewer — the
 * engine was never meant to run without a customizationConfig (it has
 * nothing to build a boundary/patches from), so this file branches on
 * product.customizable rather than forcing every product through it.
 */
(function () {
  function fmtShort(n) {
    return '₱' + Number(n).toLocaleString('en-PH');
  }

  /**
   * The cart key must represent the customer's VISUAL configuration —
   * product + variant + every layer's appearance (type, patch/text content,
   * position) IN Z-ORDER — never a runtime object id (those are just this
   * page-load's bookkeeping and mean nothing to a second customizer session
   * or to two truly identical designs, which should be able to merge).
   *
   * Two configs with the same patches at the same positions but different
   * stacking order are visually different designs, so z-order is baked
   * directly into the layer sequence below rather than sorted away.
   */
  function buildCartKey(productId, snapshot) {
    const layers = snapshot.patches.map((p) => ({ z: p.z, str: 'p:' + p.patchId + ':' + p.x + ':' + p.y }));
    if (snapshot.text) {
      layers.push({ z: snapshot.textZ, str: 't:' + snapshot.text + ':' + snapshot.textPosition.x + ':' + snapshot.textPosition.y });
    }
    layers.sort((a, b) => a.z - b.z);
    const layerKey = layers.map((l) => l.str).join('>');
    return [productId, snapshot.variantId, layerKey].join('|');
  }

  function renderStageMedia(container, product, variant) {
    container.innerHTML = '';
    container.classList.add('stage');
    const media = document.createElement('div');
    media.className = 'stage__media';
    media.style.backgroundColor = variant.hex;
    if (variant.stageImageUrl) {
      media.style.backgroundImage = `url("${variant.stageImageUrl}")`;
      media.style.backgroundSize = 'cover';
      media.style.backgroundPosition = 'center';
    } else {
      const label = document.createElement('span');
      label.className = 'stage__media-label';
      label.textContent = product.name + ' — ' + variant.name;
      media.appendChild(label);
    }
    container.appendChild(media);
  }

  // ---- non-customizable product: plain swatch + static image viewer ----

  function initSimpleProduct(product) {
    document.querySelector('[data-product-name]').textContent = product.name;
    document.querySelector('[data-product-price]').textContent = window.BuddyProducts.format(product.basePrice);
    document.querySelector('[data-addon-note]').textContent = '';
    document.querySelector('[data-add-price]').textContent = window.BuddyProducts.format(product.basePrice);

    // No customization on this product: hide the customizer-only controls
    // rather than showing empty/irrelevant fields.
    document.querySelector('.product-name-field').hidden = true;
    document.querySelector('.patch-field').hidden = true;

    let variantId = product.variants[0].id;
    let qty = 1;
    const stageEl = document.querySelector('[data-stage]');
    const qtyValEl = document.querySelector('[data-qty-val]');

    function currentVariant() {
      return product.variants.find((v) => v.id === variantId) || product.variants[0];
    }

    function renderSwatches() {
      const showSwatches = product.variants.length > 1;
      document.querySelector('.product-color-label').hidden = !showSwatches;
      const html = product.variants
        .map(
          (v) =>
            `<button type="button" class="swatch${v.id === variantId ? ' is-active' : ''}" style="background:${v.hex};" data-variant="${v.id}" title="${v.name}" aria-label="${v.name}"></button>`
        )
        .join('');
      document.querySelector('[data-swatch-row-stage]').innerHTML = showSwatches ? html : '';
      document.querySelector('[data-swatch-row-info]').innerHTML = showSwatches ? html : '';
      document.querySelector('[data-color-name]').textContent = currentVariant().name;
    }

    function render() {
      renderStageMedia(stageEl, product, currentVariant());
      renderSwatches();
    }

    document.querySelectorAll('[data-swatch-row-stage], [data-swatch-row-info]').forEach((row) => {
      row.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-variant]');
        if (!btn) return;
        variantId = btn.dataset.variant;
        render();
      });
    });

    document.querySelector('[data-qty-dec]').addEventListener('click', () => {
      qty = Math.max(1, qty - 1);
      qtyValEl.textContent = String(qty);
    });
    document.querySelector('[data-qty-inc]').addEventListener('click', () => {
      qty += 1;
      qtyValEl.textContent = String(qty);
    });

    document.querySelector('[data-zoom-btn]').addEventListener('click', () => {
      const node = document.createElement('div');
      renderStageMedia(node, product, currentVariant());
      node.classList.add('stage--zoom');
      window.BuddyModal.open(node);
    });

    document.querySelector('[data-add-to-cart]').addEventListener('click', () => {
      const variant = currentVariant();
      window.BuddyCart.addItem({
        key: [product.id, variant.id].join('|'),
        name: product.name,
        subtitle: variant.name,
        unitPrice: product.basePrice,
        qty,
        thumbColor: variant.hex,
        customization: null,
      });
      window.BuddyCart.open();
    });

    render();
  }

  // ---- customizable product: full live customizer engine ----

  function initCustomizableProduct(product) {
    const config = product.customizationConfig;
    let qty = 1;

    const stageEl = document.querySelector('[data-stage]');
    const nameInput = document.querySelector('[data-name-input]');
    const qtyValEl = document.querySelector('[data-qty-val]');
    const addBtn = document.querySelector('[data-add-to-cart]');

    const engine = window.BuddyCustomizer.create({ product, stageEl, onChange: renderInfo });

    function renderSwatches() {
      const state = engine.getState();
      const html = product.variants
        .map((v) => {
          const active = v.id === state.variantId;
          return `<button type="button" class="swatch${active ? ' is-active' : ''}" style="background:${v.hex};" data-variant="${v.id}" title="${v.name}" aria-label="${v.name}"></button>`;
        })
        .join('');
      document.querySelector('[data-swatch-row-stage]').innerHTML = html;
      document.querySelector('[data-swatch-row-info]').innerHTML = html;
    }

    function renderPatchGrid() {
      const state = engine.getState();
      const patchCount = state.objects.filter((o) => o.type === 'patch').length;
      const atMax = patchCount >= config.maxPatches;
      const unitPatchPrice = config.availablePatches[0] ? config.availablePatches[0].price : 0;

      document.querySelector('[data-patch-hint]').textContent = '(+' + fmtShort(unitPatchPrice) + ' each · up to ' + config.maxPatches + ')';

      document.querySelector('[data-patch-grid]').innerHTML = config.availablePatches
        .map((p) => {
          const placedCount = state.objects.filter((o) => o.type === 'patch' && o.patchId === p.id).length;
          const swatch = p.imageUrl
            ? `<span class="patch-chip__swatch" style="background-image:url('${p.imageUrl}');background-size:cover;background-position:center;"></span>`
            : `<span class="patch-chip__swatch" style="background:${p.hex};"></span>`;
          return (
            '<button type="button" class="patch-chip' +
            (atMax ? ' is-disabled' : '') +
            '" data-patch-id="' +
            p.id +
            '" ' +
            (atMax ? 'disabled' : '') +
            '>' +
            swatch +
            '<span class="patch-chip__name">' +
            p.name +
            '</span>' +
            (placedCount > 0 ? '<span class="patch-chip__badge">×' + placedCount + '</span>' : '') +
            '</button>'
          );
        })
        .join('');
    }

    function renderInfo() {
      const state = engine.getState();
      const variant = product.variants.find((v) => v.id === state.variantId);
      const unit = engine.getUnitPrice();
      const textObj = state.objects.find((o) => o.type === 'text');
      const patchObjs = state.objects.filter((o) => o.type === 'patch');
      const patchTotal = patchObjs.reduce((sum, o) => {
        const def = config.availablePatches.find((p) => p.id === o.patchId);
        return sum + (def ? def.price : 0);
      }, 0);

      document.querySelector('[data-color-name]').textContent = variant.name;
      document.querySelector('[data-product-price]').textContent = window.BuddyProducts.format(unit);

      const notes = [];
      if (textObj) notes.push('+ ' + fmtShort(config.textPrice) + ' name');
      if (patchObjs.length) notes.push('+ ' + fmtShort(patchTotal) + ' patches');
      document.querySelector('[data-addon-note]').textContent = notes.join(' ');

      if (!textObj) nameInput.value = '';
      else if (nameInput.value !== textObj.value) nameInput.value = textObj.value;

      document.querySelector('[data-add-price]').textContent = window.BuddyProducts.format(unit);

      renderSwatches();
      renderPatchGrid();
    }

    document.querySelectorAll('[data-swatch-row-stage], [data-swatch-row-info]').forEach((row) => {
      row.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-variant]');
        if (!btn) return;
        engine.setVariant(btn.dataset.variant);
      });
    });

    document.querySelector('[data-patch-grid]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-patch-id]');
      if (!btn || btn.disabled) return;
      engine.addPatch(btn.dataset.patchId);
    });

    nameInput.addEventListener('input', (e) => {
      engine.setText(e.target.value);
    });
    nameInput.maxLength = config.textMaxLength;
    nameInput.placeholder = 'e.g. Maya';
    document.querySelector('[data-name-hint]').textContent = `(optional · +${fmtShort(config.textPrice)} · max ${config.textMaxLength})`;

    document.querySelector('[data-qty-dec]').addEventListener('click', () => {
      qty = Math.max(1, qty - 1);
      qtyValEl.textContent = String(qty);
    });
    document.querySelector('[data-qty-inc]').addEventListener('click', () => {
      qty += 1;
      qtyValEl.textContent = String(qty);
    });

    document.querySelector('[data-zoom-btn]').addEventListener('click', () => {
      window.BuddyModal.open(engine.buildZoomNode());
    });

    addBtn.addEventListener('click', () => {
      const snapshot = engine.getSnapshot();
      const unit = engine.getUnitPrice();
      const variant = product.variants.find((v) => v.id === snapshot.variantId);
      const patchCount = snapshot.patches.length;
      const key = buildCartKey(product.id, snapshot);

      window.BuddyCart.addItem({
        key,
        name: product.name,
        subtitle: variant.name + (snapshot.text ? ' · "' + snapshot.text + '"' : '') + ' · ' + patchCount + ' patch' + (patchCount === 1 ? '' : 'es'),
        unitPrice: unit,
        qty,
        thumbColor: variant.hex,
        customization: {
          productId: product.id,
          variantId: snapshot.variantId,
          quantity: qty,
          personalization: snapshot.text
            ? { text: snapshot.text, x: snapshot.textPosition.x, y: snapshot.textPosition.y, z: snapshot.textZ }
            : null,
          patches: snapshot.patches, // each entry already carries {patchId, x, y, z} — full layer order preserved
        },
      });
      window.BuddyCart.open();
    });

    renderInfo();
  }

  async function init() {
    BuddyNav.init('#site-nav', { active: '' });
    BuddyFooter.init('#site-footer', { showNewsletter: false });
    BuddyCart.initDrawer();

    const params = new URLSearchParams(location.search);
    const slug = params.get('slug') || 'everyday-pouch';
    const product = await window.BuddyProductDetail.getBySlug(slug);
    const main = document.querySelector('main');

    if (!product) {
      main.innerHTML = '<div class="container future-page"><h1 class="sec-heading">Product not found</h1><p>That product doesn\'t exist yet.</p></div>';
      return;
    }

    document.title = product.name + ' — Buddy Patches';
    document.querySelector('[data-product-breadcrumb-name]').textContent = product.name;
    document.querySelector('[data-product-name]').textContent = product.name;
    document.querySelector('[data-product-description]').textContent = product.description;

    // catalog.js only ever includes customizationConfig when the product is
    // customizable (it omits the field entirely otherwise) — that presence
    // is the single source of truth here, not a separate boolean field the
    // API doesn't actually send.
    if (product.customizationConfig) {
      initCustomizableProduct(product);
    } else {
      initSimpleProduct(product);
    }

    await renderAlsoLike();
  }

  async function renderAlsoLike() {
    const params = new URLSearchParams(location.search);
    const slug = params.get('slug') || 'everyday-pouch';
    const all = await window.BuddyProducts.getAll();
    const others = all.filter((p) => p.slug !== slug).slice(0, 4);
    document.querySelector('[data-also-like-grid]').innerHTML = others.map(window.BuddyProductCard.render).join('');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
