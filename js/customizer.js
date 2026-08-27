/**
 * BuddyCustomizer — reusable freeform product-customization engine.
 *
 * Reads a product's `customizationConfig` (boundary, allowText, maxPatches,
 * availablePatches, ...) — never hard-codes any specific product. Any future
 * customizable product just needs a config entry in product-detail-data.js;
 * nothing in here changes.
 *
 * Coordinate system: every placed object's {x,y} is the object's CENTER as
 * a percentage of the BOUNDARY box (0,0 = boundary top-left, 100,100 =
 * boundary bottom-right) — not pixels, not percentages of the stage image.
 * That's what makes the exact same state reproduce correctly at any
 * viewport size (main stage, zoom modal, mobile, desktop).
 *
 * Layer order (z) is persistent state, not a rendering trick: every object
 * gets a z at creation, and selecting an object permanently reassigns it the
 * new top z (see selectObject). getSnapshot() exposes z per object so a
 * caller (product.js's cart key, later an order/admin preview) can rebuild
 * the exact stacking the customer designed — order is never inferred from
 * array position or from "which one is selected right now".
 *
 * DOM structure built into the mount element:
 *   .stage__media              (variant color/photo placeholder)
 *   .stage__boundary            (positioned via config.boundary %, holds objects)
 *     .stage-object              (one per placed patch/text, position:absolute
 *                                 left/top % of boundary, transform centers it)
 *
 * Dragging uses Pointer Events + setPointerCapture, so the same code path
 * handles mouse and touch. A delegated pointerdown/click listener is
 * attached once to the mount element and keeps working across re-renders
 * (render() only replaces .stage__boundary's children, never the mount
 * element itself), so there is no per-object listener re-attachment.
 */
(function () {
  const DEFAULT_PATCH_SPOTS = [
    { x: 50, y: 42 },
    { x: 34, y: 58 },
    { x: 66, y: 58 },
    { x: 30, y: 30 },
    { x: 70, y: 30 },
    { x: 50, y: 72 },
  ];
  const DEFAULT_TEXT_SPOT = { x: 50, y: 85 };

  function clampSpot(x, y, w, h) {
    const halfW = w / 2,
      halfH = h / 2;
    return {
      x: Math.min(Math.max(x, halfW), 100 - halfW),
      y: Math.min(Math.max(y, halfH), 100 - halfH),
    };
  }
  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function create({ product, stageEl, onChange }) {
    const config = product.customizationConfig;
    const debugBoundary = new URLSearchParams(location.search).has('debugBoundary');
    let idCounter = 0;
    const nextId = () => 'obj-' + ++idCounter;
    // z is a persistent layer order, not a rendering afterthought: every object
    // gets one at creation, and selecting an object permanently reassigns it
    // the new top z (not just a temporary paint-order bump). This is what
    // makes stacking order reproduce identically in the zoom modal and in the
    // cart snapshot — nothing derives order from DOM/array position or from
    // "is this the selected one" at render time.
    let zCounter = 0;
    const nextZ = () => ++zCounter;

    const state = {
      variantId: product.variants[0].id,
      objects: [],
      selectedId: null,
    };

    function notify() {
      if (onChange) onChange(getState());
    }

    function getState() {
      return {
        variantId: state.variantId,
        selectedId: state.selectedId,
        objects: state.objects.map((o) => ({ ...o })),
      };
    }

    function getUnitPrice() {
      let price = product.basePrice;
      if (state.objects.some((o) => o.type === 'text')) price += config.textPrice;
      state.objects
        .filter((o) => o.type === 'patch')
        .forEach((o) => {
          const def = config.availablePatches.find((p) => p.id === o.patchId);
          if (def) price += def.price;
        });
      return price;
    }

    function getSnapshot() {
      const textObj = state.objects.find((o) => o.type === 'text');
      return {
        variantId: state.variantId,
        text: textObj ? textObj.value : null,
        textPosition: textObj ? { x: round1(textObj.x), y: round1(textObj.y) } : null,
        textZ: textObj ? textObj.z : null,
        // z is preserved per patch (not sorted away) so callers can rebuild the
        // exact visual stacking order later — see product.js's buildCartKey.
        patches: state.objects
          .filter((o) => o.type === 'patch')
          .map((o) => ({ patchId: o.patchId, x: round1(o.x), y: round1(o.y), z: o.z })),
      };
    }

    // ---- DOM building (shared by the live stage and the zoom modal) ----

    function buildInto(container, interactive) {
      container.innerHTML = '';
      container.classList.add('stage');
      if (!interactive) container.classList.add('stage--zoom');

      const variant = product.variants.find((v) => v.id === state.variantId) || product.variants[0];

      const media = document.createElement('div');
      media.className = 'stage__media';
      media.style.backgroundColor = variant.hex;
      if (variant.stageImageUrl) {
        // Real photo when the admin has uploaded one for this variant — the
        // hex still shows briefly underneath while it loads, then is fully
        // covered. No placeholder label needed over a real image.
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

      const boundary = document.createElement('div');
      boundary.className = 'stage__boundary';
      boundary.style.top = config.boundary.top + '%';
      boundary.style.left = config.boundary.left + '%';
      boundary.style.width = config.boundary.width + '%';
      boundary.style.height = config.boundary.height + '%';
      if (interactive && debugBoundary) boundary.classList.add('stage__boundary--debug');
      container.appendChild(boundary);

      // Persistent layer order, not a temporary "selected paints last" trick —
      // z was assigned at creation and permanently reassigned on select (see
      // selectObject), so this sort reproduces identically in the zoom modal.
      const ordered = state.objects.slice().sort((a, b) => a.z - b.z);

      ordered.forEach((obj) => {
        const el = document.createElement('div');
        const selected = obj.id === state.selectedId;
        el.className = 'stage-object stage-object--' + obj.type + (selected ? ' is-selected' : '');
        el.dataset.objId = obj.id;
        el.style.left = obj.x + '%';
        el.style.top = obj.y + '%';
        el.style.width = obj.widthPct + '%';
        el.style.height = obj.heightPct + '%';
        el.style.zIndex = String(obj.z);

        if (obj.type === 'patch') {
          const def = config.availablePatches.find((p) => p.id === obj.patchId);
          if (def && def.imageUrl) {
            el.style.backgroundImage = `url("${def.imageUrl}")`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
          } else {
            el.style.background = def ? def.hex : '#ccc';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'stage-object__label';
            nameSpan.textContent = def ? def.name : obj.patchId;
            el.appendChild(nameSpan);
          }
        } else {
          const textSpan = document.createElement('span');
          textSpan.className = 'stage-object__text';
          textSpan.textContent = obj.value;
          el.appendChild(textSpan);
        }

        if (interactive && selected) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'stage-object__remove';
          rm.setAttribute('aria-label', 'Remove');
          rm.textContent = '×';
          el.appendChild(rm);
        }

        boundary.appendChild(el);
      });

      return boundary;
    }

    function render() {
      buildInto(stageEl, true);
    }

    function buildZoomNode() {
      const node = document.createElement('div');
      buildInto(node, false);
      return node;
    }

    // ---- mutation API ----

    function setVariant(id) {
      if (!product.variants.some((v) => v.id === id)) return;
      state.variantId = id;
      render();
      notify();
    }

    function selectObject(id) {
      state.selectedId = id;
      // Selecting an object permanently brings it to the front of the layer
      // order (not just a temporary paint-order bump) — the customer's next
      // drag is expected to happen without something else occluding it, and
      // that becomes the new persistent stacking order from then on.
      if (id) {
        const obj = state.objects.find((o) => o.id === id);
        if (obj) obj.z = nextZ();
      }
      render();
      notify();
    }

    function removeObject(id) {
      state.objects = state.objects.filter((o) => o.id !== id);
      if (state.selectedId === id) state.selectedId = null;
      render();
      notify();
    }

    function addPatch(patchId) {
      const count = state.objects.filter((o) => o.type === 'patch').length;
      if (count >= config.maxPatches) return false;
      const def = config.availablePatches.find((p) => p.id === patchId);
      if (!def) return false;
      const base = DEFAULT_PATCH_SPOTS[count % DEFAULT_PATCH_SPOTS.length];
      const spot = clampSpot(base.x, base.y, def.width, def.height);
      const obj = { id: nextId(), type: 'patch', patchId, x: spot.x, y: spot.y, widthPct: def.width, heightPct: def.height, z: nextZ() };
      state.objects.push(obj);
      state.selectedId = obj.id;
      render();
      notify();
      return true;
    }

    function setText(rawValue) {
      const value = (rawValue || '').slice(0, config.textMaxLength);
      const existing = state.objects.find((o) => o.type === 'text');

      if (!value) {
        if (existing) removeObject(existing.id);
        else notify();
        return;
      }

      if (existing) {
        existing.value = value;
        render();
        notify();
        return;
      }

      const spot = clampSpot(DEFAULT_TEXT_SPOT.x, DEFAULT_TEXT_SPOT.y, config.textBoxSize.width, config.textBoxSize.height);
      const obj = {
        id: nextId(),
        type: 'text',
        value,
        x: spot.x,
        y: spot.y,
        widthPct: config.textBoxSize.width,
        heightPct: config.textBoxSize.height,
        z: nextZ(),
      };
      state.objects.push(obj);
      state.selectedId = obj.id;
      render();
      notify();
    }

    // ---- drag + selection (delegated, survives re-renders) ----

    function beginDrag(el, id, pointerId) {
      const boundaryEl = el.parentElement;
      el.setPointerCapture(pointerId);

      function onMove(e) {
        if (e.pointerId !== pointerId) return;
        const obj = state.objects.find((o) => o.id === id);
        if (!obj) return;
        const rect = boundaryEl.getBoundingClientRect();
        let px = ((e.clientX - rect.left) / rect.width) * 100;
        let py = ((e.clientY - rect.top) / rect.height) * 100;
        const spot = clampSpot(px, py, obj.widthPct, obj.heightPct);
        obj.x = spot.x;
        obj.y = spot.y;
        el.style.left = spot.x + '%';
        el.style.top = spot.y + '%';
      }
      function onUp(e) {
        if (e.pointerId !== pointerId) return;
        try {
          el.releasePointerCapture(pointerId);
        } catch (err) {
          /* already released */
        }
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
      }
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    }

    stageEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.stage-object__remove')) return; // let the click handler remove it
      const objEl = e.target.closest('.stage-object');
      if (!objEl) {
        selectObject(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const id = objEl.dataset.objId;
      selectObject(id); // rebuilds DOM — re-query the fresh element below
      const freshEl = stageEl.querySelector('[data-obj-id="' + CSS.escape(id) + '"]');
      if (freshEl) beginDrag(freshEl, id, e.pointerId);
    });

    stageEl.addEventListener('click', (e) => {
      const rm = e.target.closest('.stage-object__remove');
      if (!rm) return;
      e.stopPropagation();
      const id = rm.closest('.stage-object').dataset.objId;
      removeObject(id);
    });

    render();

    return {
      getState,
      getUnitPrice,
      getSnapshot,
      setVariant,
      selectObject,
      removeObject,
      addPatch,
      setText,
      buildZoomNode,
    };
  }

  window.BuddyCustomizer = { create };
})();
