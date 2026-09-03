/**
 * Admin -> Settings (Phase 5D.2).
 *
 * Two tabs over the two Firestore configuration documents:
 *   Payments — GCash / Bank Transfer details, QR images, and the checkout
 *              master switch. OWNER ONLY to save.
 *   Shipping — delivery/pickup toggles and the Luzon/Visayas/Mindanao flat
 *              rates. Owner and Admin may save.
 *
 * The Owner-only restriction here is UX: for a non-Owner the payment
 * controls are disabled and the save button is removed. The real
 * enforcement is requireOwner() inside admin-save-payment-settings.js —
 * an Admin who re-enables the inputs in devtools still gets a 403.
 *
 * QR uploads reuse the shared image pipeline (admin/js/image-upload.js ->
 * signed URL -> direct PUT -> server-side finalize), exactly like product
 * and patch images. Nothing bespoke.
 */
import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { showToast, setButtonBusy, confirmAction } from './admin-ui.js';
import { uploadImage, removeImage } from './image-upload.js';
import { fmtMoney, escapeHtml } from './admin-format.js';

let settings = null;
let canEditPayment = false;

let emailSettings = null;
let emailLoading = false;

const $ = (sel) => document.querySelector(sel);

/* ---------------------------------------------------------------------
   Store status banner — the state the Owner must never mistake
--------------------------------------------------------------------- */

function renderStoreStatus() {
  const live = settings.payment.checkoutEnabled;
  const enabledMethods = [
    settings.payment.gcash.enabled ? 'GCash' : null,
    settings.payment.bank.enabled ? 'Bank Transfer' : null,
    ...settings.payment.legacyMethods.filter((m) => m.enabled).map((m) => m.label),
  ].filter(Boolean);

  $('[data-store-status]').innerHTML = `
    <div class="admin-store-status ${live ? 'is-live' : 'is-disabled'}">
      <div class="admin-store-status__badge">${live ? 'CHECKOUT LIVE' : 'CHECKOUT DISABLED'}</div>
      <div class="admin-store-status__body">
        <div class="admin-store-status__title">${live ? 'Customers can place orders right now.' : 'Customers cannot place any orders.'}</div>
        <div class="admin-store-status__desc">
          ${live
            ? `Accepting payment via ${enabledMethods.length ? escapeHtml(enabledMethods.join(' and ')) : 'no enabled method'}.`
            : 'The storefront shows checkout as unavailable, and the server refuses any order attempt.'}
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------------
   Tabs
--------------------------------------------------------------------- */

function initTabs() {
  document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tabBtn;
      document.querySelectorAll('[data-tab-btn]').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('[data-tab-panel]').forEach((p) => {
        p.hidden = p.dataset.tabPanel !== key;
      });
      // Reflect the tab in the URL so a dashboard/deep link can open
      // straight onto Shipping/Email, and a refresh keeps you where you were.
      history.replaceState(null, '', '?tab=' + key);
      // Email settings live behind their own endpoint (a separate Firestore
      // doc from admin-get-settings) — fetch on first visit only, same
      // lazy-load pattern as the Products editor's collections/patches data.
      if (key === 'email') loadEmail();
    });
  });

  const requested = new URLSearchParams(location.search).get('tab');
  if (requested === 'shipping' || requested === 'email') {
    document.querySelector(`[data-tab-btn="${requested}"]`).click();
  }
}

/* ---------------------------------------------------------------------
   QR image slots
--------------------------------------------------------------------- */

function renderQrSlot(which) {
  const cfg = settings.payment[which];
  const preview = $(`[data-${which}-qr-preview]`);
  const empty = $(`[data-${which}-qr-empty]`);
  const removeBtn = $(`[data-${which}-qr-remove]`);

  if (cfg.qrImageUrl) {
    preview.src = cfg.qrImageUrl;
    preview.hidden = false;
    empty.hidden = true;
    removeBtn.hidden = !canEditPayment;
  } else {
    preview.hidden = true;
    preview.removeAttribute('src');
    empty.hidden = false;
    removeBtn.hidden = true;
  }
}

function wireQrSlot(which, role) {
  const input = $(`[data-${which}-qr-input]`);
  const removeBtn = $(`[data-${which}-qr-remove]`);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    input.disabled = true;
    try {
      // Same signed-URL -> direct PUT -> finalize flow as every other image
      // in the admin. The server replaces the displaced object only after
      // Firestore points at the new one.
      const result = await uploadImage(file, { entityType: 'settings', entityId: 'payment', role });
      settings.payment[which].qrImagePath = result.path;
      settings.payment[which].qrImageUrl = result.url;
      renderQrSlot(which);
      showToast('QR image uploaded.', 'success');
    } catch (err) {
      showToast(err.message || 'QR upload failed.', 'error');
    } finally {
      input.value = '';
      input.disabled = false;
    }
  });

  removeBtn.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Remove this QR image?',
      message: 'Customers will still see the account details, just no QR code.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setButtonBusy(removeBtn, true, 'Removing…');
    try {
      await removeImage({ entityType: 'settings', entityId: 'payment', role, path: settings.payment[which].qrImagePath });
      settings.payment[which].qrImagePath = null;
      settings.payment[which].qrImageUrl = null;
      renderQrSlot(which);
      showToast('QR image removed.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not remove the QR image.', 'error');
    } finally {
      setButtonBusy(removeBtn, false);
    }
  });
}

/* ---------------------------------------------------------------------
   Payments tab
--------------------------------------------------------------------- */

function renderPayments() {
  const p = settings.payment;

  $('[data-gcash-enabled]').checked = p.gcash.enabled;
  $('[data-gcash-account-name]').value = p.gcash.accountName;
  $('[data-gcash-mobile]').value = p.gcash.mobileNumber;
  $('[data-gcash-instructions]').value = p.gcash.instructions;

  $('[data-bank-enabled]').checked = p.bank.enabled;
  $('[data-bank-bank-name]').value = p.bank.bankName;
  $('[data-bank-account-name]').value = p.bank.accountName;
  $('[data-bank-account-number]').value = p.bank.accountNumber;
  $('[data-bank-instructions]').value = p.bank.instructions;

  $('[data-checkout-enabled]').checked = p.checkoutEnabled;
  updateCheckoutSwitchLabel();

  renderQrSlot('gcash');
  renderQrSlot('bank');

  // If either card was prefilled from the pre-5D.2 methods[] array, say so —
  // saving migrates that method into the new shape rather than changing it.
  const migrating = [p.gcash.fromLegacy ? 'GCash' : null, p.bank.fromLegacy ? 'Bank Transfer' : null].filter(Boolean);
  if (migrating.length && canEditPayment) {
    const note = document.createElement('div');
    note.className = 'admin-inline-note admin-inline-note--info';
    note.style.marginBottom = '20px';
    note.innerHTML =
      `<strong>${escapeHtml(migrating.join(' and '))} ${migrating.length > 1 ? 'were' : 'was'} set up under the older settings format.</strong> ` +
      'The details below were loaded from it. Saving keeps them and moves them to the current format — nothing is lost.';
    $('[data-payment-form]').prepend(note);
  }

  if (p.legacyMethods.length) {
    $('[data-legacy-methods-card]').hidden = false;
    $('[data-legacy-methods]').innerHTML = p.legacyMethods
      .map(
        (m) =>
          `<div class="admin-timeline-item">
             <div class="admin-timeline-item__action">${escapeHtml(m.label)}</div>
             <div class="admin-timeline-item__meta">id: ${escapeHtml(m.id)} · ${m.enabled ? 'enabled' : 'disabled'}</div>
           </div>`
      )
      .join('');
  }

  if (!canEditPayment) {
    $('[data-owner-only-note]').hidden = false;
    document.querySelectorAll('[data-payment-form] input, [data-payment-form] textarea').forEach((el) => {
      el.disabled = true;
    });
    $('[data-payment-actions]').hidden = true;
  }
}

function updateCheckoutSwitchLabel() {
  const on = $('[data-checkout-enabled]').checked;
  $('[data-checkout-switch-label]').textContent = on ? 'Checkout LIVE — accepting orders' : 'Checkout disabled';
}

function collectPaymentPayload() {
  return {
    checkoutEnabled: $('[data-checkout-enabled]').checked,
    gcash: {
      enabled: $('[data-gcash-enabled]').checked,
      accountName: $('[data-gcash-account-name]').value.trim(),
      mobileNumber: $('[data-gcash-mobile]').value.trim(),
      instructions: $('[data-gcash-instructions]').value.trim(),
    },
    bank: {
      enabled: $('[data-bank-enabled]').checked,
      bankName: $('[data-bank-bank-name]').value.trim(),
      accountName: $('[data-bank-account-name]').value.trim(),
      accountNumber: $('[data-bank-account-number]').value.trim(),
      instructions: $('[data-bank-instructions]').value.trim(),
    },
  };
}

async function savePayments(e) {
  e.preventDefault();
  const btn = $('[data-save-payment]');
  const note = $('[data-payment-note]');
  note.textContent = '';
  note.className = 'admin-note';

  const payload = collectPaymentPayload();

  // Turning checkout ON is consequential enough to confirm explicitly —
  // it is the moment the store starts taking real money.
  if (payload.checkoutEnabled && !settings.payment.checkoutEnabled) {
    const ok = await confirmAction({
      title: 'Turn checkout LIVE?',
      message: 'Customers will immediately be able to place real orders and send real payments to the accounts configured above. Make sure the GCash/bank details are correct.',
      confirmLabel: 'Go live',
    });
    if (!ok) return;
  }

  setButtonBusy(btn, true, 'Saving…');
  try {
    await apiFetch('/api/admin-save-payment-settings', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Payment settings saved.', 'success');
    await load(); // re-read from the server so the status banner reflects truth, not the form
  } catch (err) {
    note.textContent = err.message;
    note.className = 'admin-note is-error';
    showToast(err.message, 'error');
  } finally {
    setButtonBusy(btn, false);
  }
}

/* ---------------------------------------------------------------------
   Shipping tab
--------------------------------------------------------------------- */

function renderShipping() {
  const s = settings.shipping;
  $('[data-delivery-enabled]').checked = s.deliveryEnabled;
  $('[data-pickup-enabled]').checked = s.pickupEnabled;
  $('[data-rate-luzon]').value = s.rates.luzon ?? '';
  $('[data-rate-visayas]').value = s.rates.visayas ?? '';
  $('[data-rate-mindanao]').value = s.rates.mindanao ?? '';
  $('[data-pickup-fee]').value = s.pickupFee ?? 0;
  $('[data-free-threshold]').value = s.freeShippingThreshold ?? '';

  // Make a still-legacy store obvious rather than silently indistinguishable
  // from a properly configured one.
  if (s.ratesSource === 'legacy-flat' && s.legacyFlatRateDelivery != null) {
    $('[data-legacy-rate-note]').hidden = false;
    $('[data-legacy-rate-value]').textContent = fmtMoney(s.legacyFlatRateDelivery);
  }
}

function numOrNull(sel) {
  const raw = $(sel).value.trim();
  return raw === '' ? null : Number(raw);
}

async function saveShipping(e) {
  e.preventDefault();
  const btn = $('[data-save-shipping]');
  const note = $('[data-shipping-note]');
  note.textContent = '';
  note.className = 'admin-note';

  const payload = {
    deliveryEnabled: $('[data-delivery-enabled]').checked,
    pickupEnabled: $('[data-pickup-enabled]').checked,
    pickupFee: numOrNull('[data-pickup-fee]') ?? 0,
    freeShippingThreshold: numOrNull('[data-free-threshold]'),
    rates: {
      luzon: numOrNull('[data-rate-luzon]'),
      visayas: numOrNull('[data-rate-visayas]'),
      mindanao: numOrNull('[data-rate-mindanao]'),
    },
  };

  setButtonBusy(btn, true, 'Saving…');
  try {
    await apiFetch('/api/admin-save-shipping-settings', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Shipping settings saved.', 'success');
    await load();
  } catch (err) {
    note.textContent = err.message;
    note.className = 'admin-note is-error';
    showToast(err.message, 'error');
  } finally {
    setButtonBusy(btn, false);
  }
}

/* ---------------------------------------------------------------------
   Email tab (Phase 5E)
--------------------------------------------------------------------- */

const EMAIL_MODE_COPY = {
  off: {
    badge: 'EMAIL OFF',
    title: 'No email is being sent.',
    desc: 'Order, payment, fulfillment, and inquiry events are still recorded, but permanently marked suppressed — nothing goes out.',
  },
  qa: {
    badge: 'QA EMAIL MODE',
    title: 'Every email is being redirected to a QA inbox.',
    desc: 'Real customers and admins receive nothing. Every otherwise-sendable email — including customer order emails — goes only to the configured QA override address.',
  },
  live: {
    badge: 'EMAIL LIVE',
    title: 'Sending real email to real customers and admins.',
    desc: 'Order, payment, fulfillment, and event-inquiry emails are being delivered to their real recipients.',
  },
};

function renderEmailModeStatus() {
  const mode = emailSettings.mode;
  const copy = EMAIL_MODE_COPY[mode] || EMAIL_MODE_COPY.off;
  $('[data-email-mode-status]').innerHTML = `
    <div class="admin-store-status is-${mode === 'live' ? 'live' : mode === 'qa' ? 'qa' : 'disabled'}">
      <div class="admin-store-status__badge">${copy.badge}</div>
      <div class="admin-store-status__body">
        <div class="admin-store-status__title">${copy.title}</div>
        <div class="admin-store-status__desc">${copy.desc}</div>
      </div>
    </div>`;
}

function renderEmailConfigGrid() {
  const c = emailSettings.config;
  const rows = [
    ['Resend API key', c.resendApiKeyConfigured],
    ['From address', c.emailFromConfigured ? escapeHtml(c.emailFromDisplay || '') : false],
    ['Site URL', c.siteUrlConfigured],
    ['Email token secret', c.emailTokenSecretConfigured],
    ['Rate limit secret', c.rateLimitSecretConfigured],
    ['Admin notification address', c.adminNotificationEmailConfigured],
  ];
  $('[data-email-config-grid]').innerHTML = rows
    .map(([label, value]) => {
      const display = value === true ? '<span class="admin-badge admin-badge--positive">Configured</span>'
        : value === false ? '<span class="admin-badge admin-badge--danger">Missing</span>'
        : value; // a literal display string, e.g. the from-address itself
      return `<div><div class="admin-kv__k">${escapeHtml(label)}</div><div class="admin-kv__v">${display}</div></div>`;
    })
    .join('');
}

function renderEmail() {
  renderEmailModeStatus();
  renderEmailConfigGrid();

  document.querySelectorAll('[data-email-mode]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.emailMode === emailSettings.mode);
    btn.disabled = !emailSettings.canChangeMode;
  });

  $('[data-email-owner-only-note]').hidden = emailSettings.canChangeMode;

  const qa = emailSettings.qaOverride;
  $('[data-email-qa-banner]').hidden = !qa.configured;
  if (qa.configured) $('[data-email-qa-hint]').textContent = qa.maskedHint || 'a configured address';

  $('[data-email-mode-note]').textContent = !emailSettings.canChangeMode
    ? ''
    : emailSettings.mode === 'qa' && !qa.configured
      ? 'QA override is not configured — switching to QA mode will be refused until EMAIL_QA_OVERRIDE_RECIPIENT is set.'
      : '';

  const issues = emailSettings.deliveryIssuesCount || 0;
  $('[data-email-issues-card]').hidden = issues === 0;
  $('[data-email-issues-count]').textContent = String(issues);
}

async function loadEmail() {
  if (emailLoading) return;
  emailLoading = true;
  try {
    emailSettings = await apiFetch('/api/admin-get-email-settings');
    renderEmail();
  } catch (err) {
    showToast(err.message || 'Could not load email settings.', 'error');
  } finally {
    emailLoading = false;
  }
}

async function changeEmailMode(mode) {
  if (!emailSettings || !emailSettings.canChangeMode || mode === emailSettings.mode) return;

  if (mode === 'live') {
    const ok = await confirmAction({
      title: 'Switch email to LIVE?',
      message: 'Buddy will start sending real email to real customers and admins for every order, payment, fulfillment, and event inquiry from now on.',
      confirmLabel: 'Go live',
    });
    if (!ok) return;
  } else if (emailSettings.mode === 'live') {
    const ok = await confirmAction({
      title: `Switch email to ${mode.toUpperCase()}?`,
      message: 'Buddy will stop sending real email to customers and admins.',
      confirmLabel: 'Confirm',
    });
    if (!ok) return;
  }

  const buttons = document.querySelectorAll('[data-email-mode]');
  buttons.forEach((b) => (b.disabled = true));
  try {
    await apiFetch('/api/admin-save-email-settings', { method: 'POST', body: JSON.stringify({ mode }) });
    showToast(`Email mode set to ${mode.toUpperCase()}.`, 'success');
    await loadEmail();
  } catch (err) {
    showToast(err.message || 'Could not change email mode.', 'error');
    renderEmail(); // restore button enabled/active state from the last known-good settings
  }
}

function wireEmailTab() {
  document.querySelectorAll('[data-email-mode]').forEach((btn) => {
    btn.addEventListener('click', () => changeEmailMode(btn.dataset.emailMode));
  });
}

/* ---------------------------------------------------------------------
   Boot
--------------------------------------------------------------------- */

async function load() {
  settings = await apiFetch('/api/admin-get-settings');
  canEditPayment = settings.canEditPayment === true;

  $('[data-settings-loading]').hidden = true;
  $('[data-settings-body]').hidden = false;

  renderStoreStatus();
  renderPayments();
  renderShipping();
}

async function init() {
  await requireSession();
  await renderAdminShell('settings');
  await load();

  initTabs();
  wireQrSlot('gcash', 'gcashQr');
  wireQrSlot('bank', 'bankQr');
  wireEmailTab();

  $('[data-checkout-enabled]').addEventListener('change', updateCheckoutSwitchLabel);
  $('[data-payment-form]').addEventListener('submit', savePayments);
  $('[data-shipping-form]').addEventListener('submit', saveShipping);
}

init();
