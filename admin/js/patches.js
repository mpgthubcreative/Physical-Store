import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { uploadImage, removeImage } from './image-upload.js';
import { confirmAction, showToast, setButtonBusy } from './admin-ui.js';
import { escapeHtml } from './admin-format.js';

let claims = null;
let patches = [];
let editingId = null;

const form = document.querySelector('[data-patch-form]');
const formCard = document.querySelector('[data-patch-form-card]');
const formNote = document.querySelector('[data-patch-form-note]');
const imageInput = document.querySelector('[data-patch-image-input]');
const imagePreview = document.querySelector('[data-patch-image-preview]');
const removeImageBtn = document.querySelector('[data-remove-patch-image]');
const reservedHint = document.querySelector('[data-patch-reserved-hint]');
const adjustmentReasonField = document.querySelector('[data-patch-adjustment-reason-field]');

let originalStockQty = null;

function setNote(text, isError) {
  formNote.textContent = text || '';
  formNote.className = 'admin-note' + (text ? (isError ? ' is-error' : ' is-success') : '');
}

function openForm(patch) {
  editingId = patch ? patch.id : null;
  originalStockQty = patch ? Number(patch.stockQty || 0) : null;
  document.querySelector('[data-form-title]').textContent = patch ? `Edit ${patch.name}` : 'New patch';
  form.reset();
  setNote('');
  form.querySelector('[name="id"]').value = editingId || '';
  form.name.value = patch?.name || '';
  form.hex.value = patch?.hex || '#F16861';
  form.price.value = patch?.price ?? 40;
  form.stockQty.value = patch?.stockQty ?? 0;
  form.active.checked = patch ? patch.active !== false : true;
  form.displayWidthPct.value = patch?.displayWidthPct ?? 17;
  form.displayHeightPct.value = patch?.displayHeightPct ?? 17;
  form.description.value = patch?.description || '';
  form.stockAdjustmentReason.value = '';
  adjustmentReasonField.hidden = true;

  reservedHint.textContent = patch ? `${patch.reservedQty || 0} currently reserved by customer order(s)` : '';

  imagePreview.src = patch?.imageUrl || '';
  imagePreview.style.visibility = patch?.imageUrl ? 'visible' : 'hidden';
  removeImageBtn.hidden = !patch?.image;
  imageInput.disabled = !editingId;
  imageInput.title = editingId ? '' : 'Save the patch first, then come back to add an image.';

  formCard.hidden = false;
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeForm() {
  formCard.hidden = true;
  editingId = null;
  originalStockQty = null;
}

form.stockQty.addEventListener('input', () => {
  const changed = originalStockQty !== null && Number(form.stockQty.value || 0) !== originalStockQty;
  adjustmentReasonField.hidden = !changed;
});

function renderRows() {
  const tbody = document.querySelector('[data-patch-rows]');
  if (!patches.length) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="admin-empty-state">
          <div class="admin-empty-state__title">No patches yet</div>
          <div class="admin-empty-state__desc">Add your first patch so customers can start customizing.</div>
        </div>
      </td></tr>`;
    return;
  }
  tbody.innerHTML = patches
    .map(
      (p) => `
    <tr>
      <td data-role="media">${p.imageUrl ? `<img class="admin-thumb" src="${p.imageUrl}" alt="" />` : `<span class="admin-thumb" style="background:${p.hex};"></span>`}</td>
      <td data-role="heading"><span class="admin-row-title">${escapeHtml(p.name)}</span></td>
      <td data-role="meta" data-label="Price">₱${p.price}</td>
      <td data-role="meta" data-label="Stock">${p.stockQty ?? 0}</td>
      <td data-role="meta" data-label="Reserved">${p.reservedQty ?? 0}</td>
      <td data-role="meta" data-label="Size">${p.displayWidthPct}×${p.displayHeightPct}</td>
      <td data-role="meta" data-label="Status"><span class="admin-badge ${p.active ? 'admin-badge--active' : 'admin-badge--inactive'}">${p.active ? 'Active' : 'Archived'}</span></td>
      <td data-role="meta" data-label="Used by">&mdash;</td>
      <td data-role="actions">
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-edit="${p.id}">Edit</button>
        ${
          p.active
            ? `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-archive="${p.id}">Archive</button>`
            : `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-reactivate="${p.id}">Reactivate</button>`
        }
        ${claims?.role === 'owner' ? `<button type="button" class="admin-btn admin-btn--danger-ghost admin-btn--small" data-delete="${p.id}">Delete</button>` : ''}
      </td>
    </tr>`
    )
    .join('');
}

async function loadPatches() {
  const data = await apiFetch('/api/admin-list-patches');
  patches = data.patches;
  renderRows();
}

document.querySelector('[data-new-patch]').addEventListener('click', () => openForm(null));
document.querySelector('[data-cancel-form]').addEventListener('click', closeForm);

document.querySelector('[data-patch-rows]').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit]');
  const archiveBtn = e.target.closest('[data-archive]');
  const reactivateBtn = e.target.closest('[data-reactivate]');
  const deleteBtn = e.target.closest('[data-delete]');

  if (editBtn) {
    openForm(patches.find((p) => p.id === editBtn.dataset.edit));
  } else if (archiveBtn) {
    await apiFetch('/api/admin-archive-patch', { method: 'POST', body: JSON.stringify({ id: archiveBtn.dataset.archive }) });
    showToast('Patch archived.', 'success');
    await loadPatches();
  } else if (reactivateBtn) {
    await apiFetch('/api/admin-reactivate-patch', { method: 'POST', body: JSON.stringify({ id: reactivateBtn.dataset.reactivate }) });
    showToast('Patch reactivated.', 'success');
    await loadPatches();
  } else if (deleteBtn) {
    const ok = await confirmAction({
      title: 'Permanently delete this patch?',
      message: 'This cannot be undone. Patches with order history, active reservations, or that are still assigned to a product can\'t be deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('/api/admin-delete-patch', { method: 'POST', body: JSON.stringify({ id: deleteBtn.dataset.delete }) });
      showToast('Patch deleted.', 'success');
      await loadPatches();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setNote('');
  const saveBtn = document.querySelector('[data-save-patch-btn]');
  setButtonBusy(saveBtn, true, 'Saving…');
  try {
    const body = {
      id: editingId || undefined,
      name: form.name.value,
      hex: form.hex.value,
      price: Number(form.price.value),
      stockQty: Number(form.stockQty.value),
      active: form.active.checked,
      displayWidthPct: Number(form.displayWidthPct.value),
      displayHeightPct: Number(form.displayHeightPct.value),
      description: form.description.value,
      stockAdjustmentReason: form.stockAdjustmentReason.value.trim(),
    };
    const result = await apiFetch('/api/admin-save-patch', { method: 'POST', body: JSON.stringify(body) });
    showToast('Patch saved.', 'success');
    editingId = result.id;
    form.querySelector('[name="id"]').value = result.id;
    imageInput.disabled = false;
    imageInput.title = '';
    originalStockQty = body.stockQty;
    form.stockAdjustmentReason.value = '';
    adjustmentReasonField.hidden = true;
    await loadPatches();
  } catch (err) {
    setNote(err.message, true);
  } finally {
    setButtonBusy(saveBtn, false);
  }
});

imageInput.addEventListener('change', async () => {
  const file = imageInput.files[0];
  if (!file || !editingId) return;
  try {
    const { url } = await uploadImage(file, { entityType: 'patch', entityId: editingId, role: 'image' });
    imagePreview.src = url;
    imagePreview.style.visibility = 'visible';
    removeImageBtn.hidden = false;
    showToast('Image uploaded.', 'success');
    await loadPatches();
  } catch (err) {
    showToast(err.message, 'error');
  }
  imageInput.value = '';
});

removeImageBtn.addEventListener('click', async () => {
  const patch = patches.find((p) => p.id === editingId);
  if (!patch || !patch.image) return;
  await removeImage({ entityType: 'patch', entityId: editingId, role: 'image', path: patch.image });
  imagePreview.src = '';
  imagePreview.style.visibility = 'hidden';
  removeImageBtn.hidden = true;
  await loadPatches();
});

async function init() {
  await requireSession();
  claims = await renderAdminShell('patches');
  await loadPatches();
}

init();
