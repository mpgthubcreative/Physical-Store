import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';

let claims = null;
let members = [];

const form = document.querySelector('[data-admin-form]');
const formCard = document.querySelector('[data-admin-form-card]');
const formNote = document.querySelector('[data-admin-form-note]');

function setNote(text, isError) {
  formNote.textContent = text || '';
  formNote.className = 'admin-note' + (text ? (isError ? ' is-error' : ' is-success') : '');
}

function openForm() {
  form.reset();
  setNote('');
  formCard.hidden = false;
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeForm() {
  formCard.hidden = true;
}

function formatDate(value) {
  if (!value) return '—';
  const date = value._seconds ? new Date(value._seconds * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderRows() {
  const tbody = document.querySelector('[data-team-rows]');
  if (!members.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">No team members yet.</td></tr>';
    return;
  }
  tbody.innerHTML = members
    .map((m) => {
      const isOwner = m.role === 'owner';
      const isSelf = m.uid === claims.uid;
      let actions = '';
      if (!isOwner) {
        actions =
          m.status === 'disabled'
            ? `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-reactivate="${m.uid}">Reactivate</button>
               <button type="button" class="admin-btn admin-btn--danger admin-btn--small" data-remove="${m.uid}">Remove access</button>`
            : `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-disable="${m.uid}">Disable</button>`;
      }
      const claimsWarning =
        m.claimsMatch === false
          ? ' <span class="admin-badge admin-badge--low" title="This account\'s Firestore record does not match its live Firebase Auth custom claims. Disable then Reactivate to repair.">Claims mismatch</span>'
          : '';

      return `
      <tr>
        <td>${m.email}${isSelf ? ' <span class="hint">(you)</span>' : ''}</td>
        <td>${isOwner ? 'Owner' : 'Admin'}</td>
        <td><span class="admin-badge ${m.status === 'active' ? 'admin-badge--active' : 'admin-badge--inactive'}">${m.status === 'active' ? 'Active' : 'Disabled'}</span>${claimsWarning}</td>
        <td>${formatDate(m.createdAt)}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('');
}

async function loadTeam() {
  const data = await apiFetch('/api/admin-list-team');
  members = data.members;
  renderRows();
}

document.querySelector('[data-new-admin]').addEventListener('click', openForm);
document.querySelector('[data-cancel-form]').addEventListener('click', closeForm);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setNote('');
  try {
    await apiFetch('/api/owner-create-admin', {
      method: 'POST',
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });
    setNote('Admin account created.', false);
    form.reset();
    closeForm();
    await loadTeam();
  } catch (err) {
    setNote(err.message, true);
  }
});

document.querySelector('[data-team-rows]').addEventListener('click', async (e) => {
  const disableBtn = e.target.closest('[data-disable]');
  const reactivateBtn = e.target.closest('[data-reactivate]');
  const removeBtn = e.target.closest('[data-remove]');

  if (disableBtn) {
    if (!confirm("Disable this admin's access? They will be signed out and unable to use the admin panel until reactivated.")) return;
    try {
      await apiFetch('/api/owner-disable-admin', { method: 'POST', body: JSON.stringify({ uid: disableBtn.dataset.disable }) });
      await loadTeam();
    } catch (err) {
      alert(err.message);
    }
  } else if (reactivateBtn) {
    try {
      await apiFetch('/api/owner-reactivate-admin', { method: 'POST', body: JSON.stringify({ uid: reactivateBtn.dataset.reactivate }) });
      await loadTeam();
    } catch (err) {
      alert(err.message);
    }
  } else if (removeBtn) {
    if (!confirm('Permanently remove this admin\'s access? This cannot be undone.')) return;
    try {
      await apiFetch('/api/owner-remove-admin', { method: 'POST', body: JSON.stringify({ uid: removeBtn.dataset.remove }) });
      await loadTeam();
    } catch (err) {
      alert(err.message);
    }
  }
});

async function init() {
  await requireSession();
  claims = await renderAdminShell('team');
  if (claims.role !== 'owner') {
    // The real enforcement is requireOwner() on every Team endpoint
    // server-side — this redirect is UX only, so a direct visit by an Admin
    // doesn't sit on a page whose data it can never load anyway.
    window.location.href = 'index.html';
    return;
  }
  await loadTeam();
}

init();
