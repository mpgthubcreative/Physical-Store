/**
 * Shared Admin UI primitives: confirmation modal (replaces window.confirm),
 * toast notifications (replaces window.alert for routine feedback), and a
 * button-loading helper. Every admin page imports from here so there is
 * exactly one modal/toast implementation, not one per page.
 */

let toastStack = null;
function getToastStack() {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'admin-toast-stack';
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

/** showToast('Saved.', 'success' | 'error' | 'info') */
export function showToast(message, type = 'info') {
  const stack = getToastStack();
  const toast = document.createElement('div');
  toast.className = `admin-toast admin-toast--${type}`;
  toast.innerHTML = `<span class="admin-toast__dot"></span><span>${message}</span>`;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));

  const remove = () => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 200);
  };
  const timer = setTimeout(remove, 4000);
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}

/**
 * confirmAction({ title, message, confirmLabel, danger }) -> Promise<boolean>
 * Renders a lightweight modal; resolves true on confirm, false on cancel/
 * Escape/backdrop click. Replaces window.confirm() for destructive or
 * otherwise consequential actions across the admin.
 */
export function confirmAction({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'admin-modal-scrim';
    scrim.innerHTML = `
      <div class="admin-modal" role="alertdialog" aria-modal="true" aria-labelledby="admin-modal-title">
        <div class="admin-modal__icon${danger ? '' : ' is-neutral'}">
          ${danger
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'}
        </div>
        <h2 id="admin-modal-title">${title}</h2>
        <p>${message}</p>
        <div class="admin-modal__actions">
          <button type="button" class="admin-btn admin-btn--ghost" data-modal-cancel>${cancelLabel}</button>
          <button type="button" class="admin-btn ${danger ? 'admin-btn--danger' : ''}" data-modal-confirm>${confirmLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(scrim);
    requestAnimationFrame(() => scrim.classList.add('is-open'));

    const close = (result) => {
      scrim.classList.remove('is-open');
      document.removeEventListener('keydown', onKeydown);
      setTimeout(() => scrim.remove(), 160);
      resolve(result);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') close(false);
    };

    scrim.querySelector('[data-modal-confirm]').addEventListener('click', () => close(true));
    scrim.querySelector('[data-modal-cancel]').addEventListener('click', () => close(false));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) close(false);
    });
    document.addEventListener('keydown', onKeydown);
    scrim.querySelector('[data-modal-confirm]').focus();
  });
}

/**
 * setButtonBusy(button, isBusy, busyLabel) — disables the button and swaps
 * its label for a small spinner + busy text while an async action runs, so
 * a slow save/upload/approval never looks like a dead click and can't be
 * double-submitted by an impatient second click.
 */
export function setButtonBusy(button, isBusy, busyLabel) {
  if (isBusy) {
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="admin-btn__spinner"></span><span>${busyLabel || 'Working…'}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.originalLabel) {
      button.innerHTML = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }
}
