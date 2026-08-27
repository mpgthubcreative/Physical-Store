import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { confirmAction, showToast, setButtonBusy } from './admin-ui.js';
import { fmtDate, escapeHtml } from './admin-format.js';

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

function initials(email) {
  const name = (email || '').split('@')[0];
  const parts = name.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || '?';
}

function renderRows() {
  const tbody = document.querySelector('[data-team-rows]');
  if (!members.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">No team members yet.</td></tr>';
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
               <button type="button" class="admin-btn admin-btn--danger-ghost admin-btn--small" data-remove="${m.uid}">Remove access</button>`
            : `<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-disable="${m.uid}">Disable</button>`;
      }
      const claimsWarning =
        m.claimsMatch === false
          ? ' <span class="admin-badge admin-badge--warning" title="This account\'s Firestore record does not match its live Firebase Auth custom claims. Disable then Reactivate to repair.">Claims mismatch</span>'
          : '';

      return `
      <tr>
        <td data-role="media"><div class="admin-account__avatar" style="${isOwner ? 'background:var(--coral);' : ''}">${initials(m.email)}</div></td>
        <td data-role="heading"><span class="admin-row-title">${escapeHtml(m.email)}</span>${isSelf ? ' <span class="admin-row-sub">(you)</span>' : ''}</td>
        <td data-role="meta" data-label="Role">${isOwner ? '<span class="admin-badge admin-badge--info">Owner</span>' : '<span class="admin-badge admin-badge--neutral">Admin</span>'}</td>
        <td data-role="meta" data-label="Status"><span class="admin-badge ${m.status === 'active' ? 'admin-badge--active' : 'admin-badge--inactive'}">${m.status === 'active' ? 'Active' : 'Disabled'}</span>${claimsWarning}</td>
        <td data-role="meta" data-label="Date added">${fmtDate(m.createdAt)}</td>
        <td data-role="actions">${actions}</td>
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
  const createBtn = document.querySelector('[data-create-admin-btn]');
  setButtonBusy(createBtn, true, 'Creating…');
  try {
    await apiFetch('/api/owner-create-admin', {
      method: 'POST',
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });
    showToast('Admin account created.', 'success');
    form.reset();
    closeForm();
    await loadTeam();
  } catch (err) {
    setNote(err.message, true);
  } finally {
    setButtonBusy(createBtn, false);
  }
});

document.querySelector('[data-team-rows]').addEventListener('click', async (e) => {
  const disableBtn = e.target.closest('[data-disable]');
  const reactivateBtn = e.target.closest('[data-reactivate]');
  const removeBtn = e.target.closest('[data-remove]');

  if (disableBtn) {
    const ok = await confirmAction({
      title: "Disable this admin's access?",
      message: 'They will be signed out and unable to use the admin panel until reactivated.',
      confirmLabel: 'Disable',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('/api/owner-disable-admin', { method: 'POST', body: JSON.stringify({ uid: disableBtn.dataset.disable }) });
      showToast('Admin disabled.', 'success');
      await loadTeam();
    } catch (err) {
      showToast(err.message, 'error');
    }
  } else if (reactivateBtn) {
    try {
      await apiFetch('/api/owner-reactivate-admin', { method: 'POST', body: JSON.stringify({ uid: reactivateBtn.dataset.reactivate }) });
      showToast('Admin reactivated.', 'success');
      await loadTeam();
    } catch (err) {
      showToast(err.message, 'error');
    }
  } else if (removeBtn) {
    const ok = await confirmAction({
      title: "Permanently remove this admin's access?",
      message: 'This cannot be undone.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('/api/owner-remove-admin', { method: 'POST', body: JSON.stringify({ uid: removeBtn.dataset.remove }) });
      showToast('Admin access removed.', 'success');
      await loadTeam();
    } catch (err) {
      showToast(err.message, 'error');
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
