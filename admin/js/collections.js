import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { uploadImage, removeImage } from './image-upload.js';
import { confirmAction, showToast, setButtonBusy } from './admin-ui.js';
import { escapeHtml } from './admin-format.js';

let claims = null;
let collections = [];
let editingId = null;

const form = document.querySelector('[data-collection-form]');
const formCard = document.querySelector('[data-collection-form-card]');
const formNote = document.querySelector('[data-collection-form-note]');
const imageInput = document.querySelector('[data-collection-image-input]');
const imagePreview = document.querySelector('[data-collection-image-preview]');
const removeImageBtn = document.querySelector('[data-remove-collection-image]');

function setNote(text, isError) {
  formNote.textContent = text || '';
  formNote.className = 'admin-note' + (text ? (isError ? ' is-error' : ' is-success') : '');
}

function openForm(collection) {
  editingId = collection ? collection.id : null;
  document.querySelector('[data-form-title]').textContent = collection ? `Edit ${collection.name}` : 'New collection';
  form.reset();
  setNote('');
  form.querySelector('[name="id"]').value = editingId || '';
  form.name.value = collection?.name || '';
  form.slug.value = collection?.slug || '';
  form.sortOrder.value = collection?.sortOrder ?? 0;
  form.active.checked = collection ? collection.active !== false : true;
  form.featured.checked = collection?.featured || false;
  form.description.value = collection?.description || '';

  imagePreview.src = collection?.imageUrl || '';
  imagePreview.style.visibility = collection?.imageUrl ? 'visible' : 'hidden';
  removeImageBtn.hidden = !collection?.image;
  imageInput.disabled = !editingId;
  imageInput.title = editingId ? '' : 'Save the collection first, then come back to add an image.';

  formCard.hidden = false;
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeForm() {
  formCard.hidden = true;
  editingId = null;
}

function renderRows() {
  const tbody = document.querySelector('[data-collection-rows]');
  if (!collections.length) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="admin-empty-state">
          <div class="admin-empty-state__title">No collections yet</div>
          <div class="admin-empty-state__desc">Group products together so they're easy to browse on the storefront.</div>
        </div>
      </td></tr>`;
    return;
  }
  tbody.innerHTML = collections
    .map(
      (c) => `
    <tr>
      <td data-role="media">${c.imageUrl ? `<img class="admin-thumb" src="${c.imageUrl}" alt="" loading="lazy" decoding="async" width="42" height="42" />` : `<span class="admin-thumb"></span>`}</td>
      <td data-role="heading"><span class="admin-row-title">${escapeHtml(c.name)}</span>${c.featured ? ' <span class="admin-badge admin-badge--info">Featured</span>' : ''}</td>
      <td data-role="meta" data-label="Slug">${escapeHtml(c.slug)}</td>
      <td data-role="meta" data-label="Status"><span class="admin-badge ${c.active ? 'admin-badge--active' : 'admin-badge--inactive'}">${c.active ? 'Active' : 'Archived'}</span></td>
      <td data-role="actions">
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-edit="${c.id}">Edit</button>
        ${
          c.active
            ? `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-archive="${c.id}">Archive</button>`
            : `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-reactivate="${c.id}">Reactivate</button>`
        }
        ${claims?.role === 'owner' ? `<button type="button" class="admin-btn admin-btn--danger-ghost admin-btn--small" data-delete="${c.id}">Delete</button>` : ''}
      </td>
    </tr>`
    )
    .join('');
}

async function loadCollections() {
  const data = await apiFetch('/api/admin-list-collections');
  collections = data.collections;
  renderRows();
}

document.querySelector('[data-new-collection]').addEventListener('click', () => openForm(null));
document.querySelector('[data-cancel-form]').addEventListener('click', closeForm);

document.querySelector('[data-collection-rows]').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit]');
  const archiveBtn = e.target.closest('[data-archive]');
  const reactivateBtn = e.target.closest('[data-reactivate]');
  const deleteBtn = e.target.closest('[data-delete]');

  if (editBtn) {
    openForm(collections.find((c) => c.id === editBtn.dataset.edit));
  } else if (archiveBtn) {
    await apiFetch('/api/admin-archive-collection', { method: 'POST', body: JSON.stringify({ id: archiveBtn.dataset.archive }) });
    showToast('Collection archived.', 'success');
    await loadCollections();
  } else if (reactivateBtn) {
    await apiFetch('/api/admin-reactivate-collection', { method: 'POST', body: JSON.stringify({ id: reactivateBtn.dataset.reactivate }) });
    showToast('Collection reactivated.', 'success');
    await loadCollections();
  } else if (deleteBtn) {
    const ok = await confirmAction({
      title: 'Permanently delete this collection?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('/api/admin-delete-collection', { method: 'POST', body: JSON.stringify({ id: deleteBtn.dataset.delete }) });
      showToast('Collection deleted.', 'success');
      await loadCollections();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setNote('');
  const saveBtn = document.querySelector('[data-save-collection-btn]');
  setButtonBusy(saveBtn, true, 'Saving…');
  try {
    const body = {
      id: editingId || undefined,
      name: form.name.value,
      slug: form.slug.value,
      sortOrder: Number(form.sortOrder.value || 0),
      active: form.active.checked,
      featured: form.featured.checked,
      description: form.description.value,
    };
    const result = await apiFetch('/api/admin-save-collection', { method: 'POST', body: JSON.stringify(body) });
    showToast('Collection saved.', 'success');
    editingId = result.id;
    form.querySelector('[name="id"]').value = result.id;
    imageInput.disabled = false;
    imageInput.title = '';
    await loadCollections();
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
    const { url } = await uploadImage(file, { entityType: 'collection', entityId: editingId, role: 'image' });
    imagePreview.src = url;
    imagePreview.style.visibility = 'visible';
    removeImageBtn.hidden = false;
    showToast('Image uploaded.', 'success');
    await loadCollections();
  } catch (err) {
    showToast(err.message, 'error');
  }
  imageInput.value = '';
});

removeImageBtn.addEventListener('click', async () => {
  const collection = collections.find((c) => c.id === editingId);
  if (!collection || !collection.image) return;
  await removeImage({ entityType: 'collection', entityId: editingId, role: 'image', path: collection.image });
  imagePreview.src = '';
  imagePreview.style.visibility = 'hidden';
  removeImageBtn.hidden = true;
  await loadCollections();
});

async function init() {
  await requireSession();
  claims = await renderAdminShell('collections');
  await loadCollections();
}

init();
