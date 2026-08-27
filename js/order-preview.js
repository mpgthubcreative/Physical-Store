/**
 * BuddyOrderPreview — read-only reconstruction of a historical order line's
 * customization, rendered from its permanent snapshot (never live catalog
 * data). Deliberately reuses the exact same DOM structure/CSS classes as
 * the live customizer (js/customizer.js: .stage, .stage__boundary,
 * .stage-object, .stage-object--patch/--text) so this can never visually
 * drift from what the customer actually designed — same boundary-relative
 * % coordinates, same z-order, same image-vs-color-label fallback.
 *
 * Used by both the customer's order.html and the Admin order-detail page.
 */
(function () {
  function buildPatchNode(p) {
    const el = document.createElement('div');
    el.className = 'stage-object stage-object--patch';
    el.style.left = p.x + '%';
    el.style.top = p.y + '%';
    el.style.width = p.widthPct + '%';
    el.style.height = p.heightPct + '%';
    el.style.zIndex = String(p.z);
    if (p.imageUrl) {
      el.style.backgroundImage = 'url("' + p.imageUrl + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } else {
      el.style.background = p.hex || '#ccc';
      const label = document.createElement('span');
      label.className = 'stage-object__label';
      label.textContent = p.patchName || '';
      el.appendChild(label);
    }
    return el;
  }

  function buildTextNode(t) {
    const el = document.createElement('div');
    el.className = 'stage-object stage-object--text';
    el.style.left = t.x + '%';
    el.style.top = t.y + '%';
    if (t.boxWidthPct != null) el.style.width = t.boxWidthPct + '%';
    if (t.boxHeightPct != null) el.style.height = t.boxHeightPct + '%';
    el.style.zIndex = String(t.z);
    const span = document.createElement('span');
    span.className = 'stage-object__text';
    span.textContent = t.value;
    el.appendChild(span);
    return el;
  }

  /** customization: the exact snapshot shape stored on an order line (rendererVersion, boundary, variant, text, patches). */
  function render(container, customization) {
    container.innerHTML = '';
    if (!customization) return;

    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.style.backgroundColor = customization.variant.hex;
    if (customization.variant.stageImageUrl) {
      stage.style.backgroundImage = 'url("' + customization.variant.stageImageUrl + '")';
      stage.style.backgroundSize = 'cover';
      stage.style.backgroundPosition = 'center';
    }

    const boundary = document.createElement('div');
    boundary.className = 'stage__boundary';
    boundary.style.top = customization.boundary.top + '%';
    boundary.style.left = customization.boundary.left + '%';
    boundary.style.width = customization.boundary.width + '%';
    boundary.style.height = customization.boundary.height + '%';

    const layers = [];
    (customization.patches || []).forEach((p) => layers.push({ z: p.z, build: () => buildPatchNode(p) }));
    if (customization.text) layers.push({ z: customization.text.z, build: () => buildTextNode(customization.text) });
    layers
      .sort((a, b) => a.z - b.z)
      .forEach((l) => boundary.appendChild(l.build()));

    stage.appendChild(boundary);
    container.appendChild(stage);
  }

  window.BuddyOrderPreview = { render };
})();
