import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { uploadImage, removeImage } from './image-upload.js';

let claims = null;
let patches = [];
let editingId = null;

const form = document.querySelector('[data-patch-form]');
const formCard = document.querySelector('[data-patch-form-card]');
const formNote = document.querySelector('[data-patch-form-note]');
const imageInput = document.querySelector('[data-patch-image-input]');
const imagePreview = document.querySelector('[data-patch-image-preview]');
const removeImageBtn = document.querySelector('[data-remove-patch-image]');

function setNote(text, isError) {
  formNote.textContent = text || '';
  formNote.className = 'admin-note' + (text ? (isError ? ' is-error' : ' is-success') : '');
}

function openForm(patch) {
  editingId = patch ? patch.id : null;
  document.querySelector('[data-form-title]').textContent = patch ? `Edit ${patch.name}` : 'New patch';
  form.reset();
  setNote('');
  form.querySelector('[name="id"]').value = editingId || '';
  form.name.value = patch?.name || '';
  form.hex.value = patch?.hex || '#F16861';
  form.price.value = patch?.price ?? 40;
  form.active.checked = patch ? patch.active !== false : true;
  form.displayWidthPct.value = patch?.displayWidthPct ?? 17;
  form.displayHeightPct.value = patch?.displayHeightPct ?? 17;
  form.description.value = patch?.description || '';

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
}

function renderRows() {
  const tbody = document.querySelector('[data-patch-rows]');
  if (!patches.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">No patches yet — add your first one.</td></tr>';
    return;
  }
  tbody.innerHTML = patches
    .map(
      (p) => `
    <tr>
      <td>${p.imageUrl ? `<img class="admin-thumb" src="${p.imageUrl}" alt="" />` : `<span class="admin-thumb" style="background:${p.hex};"></span>`}</td>
      <td>${p.name}</td>
      <td>₱${p.price}</td>
      <td>${p.displayWidthPct}×${p.displayHeightPct}</td>
      <td><span class="admin-badge ${p.active ? 'admin-badge--active' : 'admin-badge--inactive'}">${p.active ? 'Active' : 'Archived'}</span></td>
      <td>&mdash;</td>
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
    await loadPatches();
  } else if (reactivateBtn) {
    await apiFetch('/api/admin-reactivate-patch', { method: 'POST', body: JSON.stringify({ id: reactivateBtn.dataset.reactivate }) });
    await loadPatches();
  } else if (deleteBtn) {
    if (!confirm('Permanently delete this patch? This cannot be undone.')) return;
    try {
      await apiFetch('/api/admin-delete-patch', { method: 'POST', body: JSON.stringify({ id: deleteBtn.dataset.delete }) });
      await loadPatches();
    } catch (err) {
      alert(err.message);
    }
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setNote('');
  try {
    const body = {
      id: editingId || undefined,
      name: form.name.value,
      hex: form.hex.value,
      price: Number(form.price.value),
      active: form.active.checked,
      displayWidthPct: Number(form.displayWidthPct.value),
      displayHeightPct: Number(form.displayHeightPct.value),
      description: form.description.value,
    };
    const result = await apiFetch('/api/admin-save-patch', { method: 'POST', body: JSON.stringify(body) });
    setNote('Saved.', false);
    editingId = result.id;
    form.querySelector('[name="id"]').value = result.id;
    imageInput.disabled = false;
    imageInput.title = '';
    await loadPatches();
  } catch (err) {
    setNote(err.message, true);
  }
});

imageInput.addEventListener('change', async () => {
  const file = imageInput.files[0];
  if (!file || !editingId) return;
  setNote('Uploading image…', false);
  try {
    const { url } = await uploadImage(file, { entityType: 'patch', entityId: editingId, role: 'image' });
    imagePreview.src = url;
    imagePreview.style.visibility = 'visible';
    removeImageBtn.hidden = false;
    setNote('Image uploaded.', false);
    await loadPatches();
  } catch (err) {
    setNote(err.message, true);
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
