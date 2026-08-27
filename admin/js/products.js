import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { uploadImage, removeImage } from './image-upload.js';

let claims = null;
let products = [];
let collections = [];
let patches = [];
let editingId = null;
let editingProduct = null; // full detail record while the form is open, for image gating/removal

const form = document.querySelector('[data-product-form]');
const formCard = document.querySelector('[data-product-form-card]');
const formNote = document.querySelector('[data-product-form-note]');
const variantRowsEl = document.querySelector('[data-variant-rows]');
const variantTemplate = document.getElementById('variant-row-template');
const thumbnailInput = document.querySelector('[data-thumbnail-input]');
const thumbnailPreview = document.querySelector('[data-thumbnail-preview]');
const removeThumbnailBtn = document.querySelector('[data-remove-thumbnail]');
const customizableCheckbox = document.querySelector('[data-customizable]');
const customizationFields = document.querySelector('[data-customization-fields]');
const allowTextCheckbox = document.querySelector('[data-allow-text]');
const textFields = document.querySelector('[data-text-fields]');
const adjustmentReasonField = document.querySelector('[data-adjustment-reason-field]');

let originalStockByVariantId = new Map();

function refreshAdjustmentReasonVisibility() {
  const changed = Array.from(variantRowsEl.querySelectorAll('[data-variant-row]')).some((row) => {
    const variantId = row.querySelector('[data-v-id]').value.trim();
    if (!variantId || !originalStockByVariantId.has(variantId)) return false; // new variant — not an "adjustment"
    return Number(row.querySelector('[data-v-stock]').value || 0) !== originalStockByVariantId.get(variantId);
  });
  adjustmentReasonField.hidden = !changed;
}

function setNote(text, isError) {
  formNote.textContent = text || '';
  formNote.className = 'admin-note' + (text ? (isError ? ' is-error' : ' is-success') : '');
}

// ---- variant rows ----

function addVariantRow(variant) {
  const frag = variantTemplate.content.cloneNode(true);
  const row = frag.querySelector('[data-variant-row]');

  row.querySelector('[data-v-id]').value = variant?.variantId || '';
  row.querySelector('[data-v-name]').value = variant?.name || '';
  row.querySelector('[data-v-hex]').value = variant?.hex || '#38B2B3';
  row.querySelector('[data-v-sku]').value = variant?.sku || '';
  row.querySelector('[data-v-stock]').value = variant?.stockQty ?? 0;
  row.querySelector('[data-v-low]').value = variant?.lowStockThreshold ?? 5;
  row.querySelector('[data-v-active]').checked = variant ? variant.active !== false : true;
  row.querySelector('[data-v-reserved-hint]').textContent = variant ? `${variant.reservedQty || 0} reserved` : '';
  row.querySelector('[data-v-stock]').addEventListener('input', refreshAdjustmentReasonVisibility);

  const imgPreview = row.querySelector('[data-v-image-preview]');
  const imgInput = row.querySelector('[data-v-image-input]');
  imgPreview.src = variant?.stageImageUrl || '';
  imgPreview.style.visibility = variant?.stageImageUrl ? 'visible' : 'hidden';
  imgInput.disabled = !editingId || !variant?.variantId;
  imgInput.title = imgInput.disabled ? 'Save the product first, then come back to add a stage image for this variant.' : '';

  imgInput.addEventListener('change', async () => {
    const file = imgInput.files[0];
    const variantId = row.querySelector('[data-v-id]').value.trim();
    if (!file || !editingId || !variantId) return;
    setNote('Uploading stage image…', false);
    try {
      const { url } = await uploadImage(file, { entityType: 'product', entityId: editingId, role: 'stageImage', variantId });
      imgPreview.src = url;
      imgPreview.style.visibility = 'visible';
      setNote('Stage image uploaded.', false);
    } catch (err) {
      setNote(err.message, true);
    }
    imgInput.value = '';
  });

  row.querySelector('[data-remove-variant]').addEventListener('click', () => row.remove());

  variantRowsEl.appendChild(frag);
}

function collectVariantsFromForm() {
  return Array.from(variantRowsEl.querySelectorAll('[data-variant-row]')).map((row) => ({
    variantId: row.querySelector('[data-v-id]').value.trim(),
    name: row.querySelector('[data-v-name]').value.trim(),
    hex: row.querySelector('[data-v-hex]').value.trim(),
    sku: row.querySelector('[data-v-sku]').value.trim(),
    stockQty: Number(row.querySelector('[data-v-stock]').value || 0),
    lowStockThreshold: Number(row.querySelector('[data-v-low]').value || 5),
    active: row.querySelector('[data-v-active]').checked,
  }));
}

// ---- checkboxes (collections + available patches) ----

function renderCollectionCheckboxes(selectedIds) {
  const mount = document.querySelector('[data-collection-checkboxes]');
  if (!collections.length) {
    mount.innerHTML = '<p class="hint" style="font-size:13px;">No collections yet — create one on the Collections page.</p>';
    return;
  }
  mount.innerHTML = collections
    .map(
      (c) => `
    <label class="admin-patch-pick ${selectedIds.includes(c.id) ? 'is-checked' : ''}">
      <input type="checkbox" value="${c.id}" ${selectedIds.includes(c.id) ? 'checked' : ''} />
      ${c.name}${c.active ? '' : ' (archived)'}
    </label>`
    )
    .join('');
  mount.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => cb.closest('.admin-patch-pick').classList.toggle('is-checked', cb.checked)));
}

function renderPatchCheckboxes(selectedIds) {
  const mount = document.querySelector('[data-patch-checkboxes]');
  if (!patches.length) {
    mount.innerHTML = '<p class="hint" style="font-size:13px;">No patches yet — create some on the Patches page.</p>';
    return;
  }
  mount.innerHTML = patches
    .map(
      (p) => `
    <label class="admin-patch-pick ${selectedIds.includes(p.id) ? 'is-checked' : ''}">
      <input type="checkbox" value="${p.id}" ${selectedIds.includes(p.id) ? 'checked' : ''} />
      <span class="admin-patch-swatch" style="background:${p.hex};"></span>
      ${p.name}${p.active ? '' : ' (archived)'}
    </label>`
    )
    .join('');
  mount.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => cb.closest('.admin-patch-pick').classList.toggle('is-checked', cb.checked)));
}

function getCheckedValues(selector) {
  return Array.from(document.querySelectorAll(selector + ' input:checked')).map((el) => el.value);
}

// ---- form open/close ----

function openForm(product) {
  editingId = product ? product.id : null;
  editingProduct = product || null;
  document.querySelector('[data-form-title]').textContent = product ? `Edit ${product.title}` : 'New product';
  form.reset();
  setNote('');
  variantRowsEl.innerHTML = '';

  originalStockByVariantId = new Map((product?.variants || []).map((v) => [v.variantId, Number(v.stockQty || 0)]));
  form.stockAdjustmentReason.value = '';
  adjustmentReasonField.hidden = true;

  form.querySelector('[name="id"]').value = editingId || '';
  form.title.value = product?.title || '';
  form.slug.value = product?.slug || '';
  form.basePrice.value = product?.basePrice ?? 0;
  form.category.value = product?.category || '';
  form.badge.value = product?.badge || '';
  form.active.checked = product ? product.active !== false : true;
  form.featured.checked = product?.featured || false;
  form.description.value = product?.description || '';

  thumbnailPreview.src = product?.thumbnailUrl || '';
  thumbnailPreview.style.visibility = product?.thumbnailUrl ? 'visible' : 'hidden';
  removeThumbnailBtn.hidden = !product?.thumbnail;
  thumbnailInput.disabled = !editingId;
  thumbnailInput.title = editingId ? '' : 'Save the product first, then come back to add a thumbnail.';

  renderCollectionCheckboxes(product?.collectionIds || []);
  renderPatchCheckboxes(product?.customizationConfig?.availablePatchIds || []);

  if (product) {
    (product.variants || []).forEach((v) => addVariantRow(v));
  } else {
    addVariantRow(null); // start a brand-new product with exactly one blank variant row
  }

  const cfg = product?.customizationConfig;
  customizableCheckbox.checked = !!product?.customizable;
  customizationFields.hidden = !product?.customizable;
  document.querySelector('[data-boundary-top]').value = cfg?.boundary?.top ?? 10;
  document.querySelector('[data-boundary-left]').value = cfg?.boundary?.left ?? 10;
  document.querySelector('[data-boundary-width]').value = cfg?.boundary?.width ?? 80;
  document.querySelector('[data-boundary-height]').value = cfg?.boundary?.height ?? 76;
  document.querySelector('[data-max-patches]').value = cfg?.maxPatches ?? 6;
  allowTextCheckbox.checked = !!cfg?.allowText;
  textFields.hidden = !cfg?.allowText;
  document.querySelector('[data-text-max-length]').value = cfg?.textMaxLength ?? 10;
  document.querySelector('[data-text-price]').value = cfg?.textPrice ?? 30;
  document.querySelector('[data-text-box-width]').value = cfg?.textBoxSize?.width ?? 46;
  document.querySelector('[data-text-box-height]').value = cfg?.textBoxSize?.height ?? 13;

  formCard.hidden = false;
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeForm() {
  formCard.hidden = true;
  editingId = null;
  editingProduct = null;
}

customizableCheckbox.addEventListener('change', () => {
  customizationFields.hidden = !customizableCheckbox.checked;
});
allowTextCheckbox.addEventListener('change', () => {
  textFields.hidden = !allowTextCheckbox.checked;
});

// ---- list rendering ----

function renderRows() {
  const tbody = document.querySelector('[data-product-rows]');
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="admin-empty">No products yet — add your first one.</td></tr>';
    return;
  }
  tbody.innerHTML = products
    .map(
      (p) => `
    <tr>
      <td>${p.thumbnailUrl ? `<img class="admin-thumb" src="${p.thumbnailUrl}" alt="" />` : `<span class="admin-thumb"></span>`}</td>
      <td>${p.title}${p.featured ? ' <span class="admin-badge admin-badge--active">Featured</span>' : ''}</td>
      <td>₱${p.basePrice}</td>
      <td>${p.variantCount}</td>
      <td>${p.totalStock === 0 ? '<span class="admin-badge admin-badge--low">Out of stock</span>' : p.totalStock}</td>
      <td>${p.totalReserved || 0}</td>
      <td><span class="admin-badge ${p.active ? 'admin-badge--active' : 'admin-badge--inactive'}">${p.active ? 'Active' : 'Archived'}</span></td>
      <td>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-edit="${p.id}">Edit</button>
        ${
          p.active
            ? `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-archive="${p.id}">Archive</button>`
            : `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-reactivate="${p.id}">Reactivate</button>`
        }
        ${claims?.role === 'owner' ? `<button type="button" class="admin-btn admin-btn--danger admin-btn--small" data-delete="${p.id}">Delete</button>` : ''}
      </td>
    </tr>`
    )
    .join('');
}

async function loadProducts() {
  const data = await apiFetch('/api/admin-list-products');
  products = data.products;
  renderRows();
}

document.querySelector('[data-new-product]').addEventListener('click', () => openForm(null));
document.querySelector('[data-cancel-form]').addEventListener('click', closeForm);
document.querySelector('[data-add-variant]').addEventListener('click', () => addVariantRow(null));

document.querySelector('[data-product-rows]').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit]');
  const archiveBtn = e.target.closest('[data-archive]');
  const reactivateBtn = e.target.closest('[data-reactivate]');
  const deleteBtn = e.target.closest('[data-delete]');

  if (editBtn) {
    const { product } = await apiFetch('/api/admin-get-product?id=' + encodeURIComponent(editBtn.dataset.edit));
    openForm(product);
  } else if (archiveBtn) {
    await apiFetch('/api/admin-archive-product', { method: 'POST', body: JSON.stringify({ id: archiveBtn.dataset.archive }) });
    await loadProducts();
  } else if (reactivateBtn) {
    await apiFetch('/api/admin-reactivate-product', { method: 'POST', body: JSON.stringify({ id: reactivateBtn.dataset.reactivate }) });
    await loadProducts();
  } else if (deleteBtn) {
    if (!confirm('Permanently delete this product? This cannot be undone.')) return;
    try {
      await apiFetch('/api/admin-delete-product', { method: 'POST', body: JSON.stringify({ id: deleteBtn.dataset.delete }) });
      await loadProducts();
    } catch (err) {
      alert(err.message);
    }
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setNote('');
  try {
    const customizable = customizableCheckbox.checked;
    const allowText = allowTextCheckbox.checked;

    const body = {
      id: editingId || undefined,
      title: form.title.value,
      slug: form.slug.value,
      basePrice: Number(form.basePrice.value),
      category: form.category.value,
      badge: form.badge.value,
      active: form.active.checked,
      featured: form.featured.checked,
      description: form.description.value,
      thumbnail: editingProduct?.thumbnail || '',
      gallery: editingProduct?.gallery || [],
      collectionIds: getCheckedValues('[data-collection-checkboxes]'),
      variants: collectVariantsFromForm(),
      stockAdjustmentReason: form.stockAdjustmentReason.value.trim(),
      customizable,
      customizationConfig: customizable
        ? {
            boundary: {
              top: Number(document.querySelector('[data-boundary-top]').value),
              left: Number(document.querySelector('[data-boundary-left]').value),
              width: Number(document.querySelector('[data-boundary-width]').value),
              height: Number(document.querySelector('[data-boundary-height]').value),
            },
            allowText,
            textMaxLength: allowText ? Number(document.querySelector('[data-text-max-length]').value) : 0,
            textPrice: allowText ? Number(document.querySelector('[data-text-price]').value) : 0,
            textBoxSize: {
              width: Number(document.querySelector('[data-text-box-width]').value || 40),
              height: Number(document.querySelector('[data-text-box-height]').value || 12),
            },
            maxPatches: Number(document.querySelector('[data-max-patches]').value),
            availablePatchIds: getCheckedValues('[data-patch-checkboxes]'),
          }
        : null,
    };

    const result = await apiFetch('/api/admin-save-product', { method: 'POST', body: JSON.stringify(body) });
    setNote('Saved.', false);
    editingId = result.id;
    form.querySelector('[name="id"]').value = result.id;
    thumbnailInput.disabled = false;
    thumbnailInput.title = '';
    await loadProducts();

    // Re-fetch full detail so newly-created variants/images can now accept uploads.
    const { product } = await apiFetch('/api/admin-get-product?id=' + encodeURIComponent(result.id));
    editingProduct = product;
    variantRowsEl.innerHTML = '';
    (product.variants || []).forEach((v) => addVariantRow(v));
    originalStockByVariantId = new Map((product.variants || []).map((v) => [v.variantId, Number(v.stockQty || 0)]));
    form.stockAdjustmentReason.value = '';
    adjustmentReasonField.hidden = true;
  } catch (err) {
    setNote(err.message, true);
  }
});

thumbnailInput.addEventListener('change', async () => {
  const file = thumbnailInput.files[0];
  if (!file || !editingId) return;
  setNote('Uploading thumbnail…', false);
  try {
    const { url, path } = await uploadImage(file, { entityType: 'product', entityId: editingId, role: 'thumbnail' });
    thumbnailPreview.src = url;
    thumbnailPreview.style.visibility = 'visible';
    removeThumbnailBtn.hidden = false;
    editingProduct = { ...editingProduct, thumbnail: path };
    setNote('Thumbnail uploaded.', false);
    await loadProducts();
  } catch (err) {
    setNote(err.message, true);
  }
  thumbnailInput.value = '';
});

removeThumbnailBtn.addEventListener('click', async () => {
  if (!editingProduct?.thumbnail) return;
  await removeImage({ entityType: 'product', entityId: editingId, role: 'thumbnail', path: editingProduct.thumbnail });
  thumbnailPreview.src = '';
  thumbnailPreview.style.visibility = 'hidden';
  removeThumbnailBtn.hidden = true;
  editingProduct = { ...editingProduct, thumbnail: '' };
  await loadProducts();
});

async function init() {
  await requireSession();
  claims = await renderAdminShell('products');
  const [{ collections: c }, { patches: p }] = await Promise.all([
    apiFetch('/api/admin-list-collections'),
    apiFetch('/api/admin-list-patches'),
  ]);
  collections = c;
  patches = p;
  await loadProducts();
}

init();
