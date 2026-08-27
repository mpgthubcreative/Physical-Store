import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';

async function init() {
  await requireSession();
  await renderAdminShell('dashboard');

  try {
    const [{ products }, { patches }, { collections }] = await Promise.all([
      apiFetch('/api/admin-list-products'),
      apiFetch('/api/admin-list-patches'),
      apiFetch('/api/admin-list-collections'),
    ]);

    document.querySelector('[data-count-products]').textContent = products.length;
    document.querySelector('[data-count-patches]').textContent = patches.length;
    document.querySelector('[data-count-collections]').textContent = collections.length;

    const lowStock = products.reduce((count, p) => {
      // admin-list-products only returns aggregate totalStock, so a true
      // per-variant low-stock count needs the detail endpoint; this is a
      // reasonable proxy (products with zero total stock) until a
      // dedicated summary function exists.
      return count + (p.totalStock === 0 ? 1 : 0);
    }, 0);
    document.querySelector('[data-count-lowstock]').textContent = lowStock;
  } catch (err) {
    console.error(err);
  }
}

init();
