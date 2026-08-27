/**
 * Contact page: nav/footer + contact-form frontend validation only.
 * No backend yet — same future wiring note as events.js.
 */
(function () {
  function wireContactForm() {
    const form = document.querySelector('[data-contact-form]');
    if (!form) return;
    const note = form.querySelector('[data-form-note]');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = form.querySelector('[name="name"]').value.trim();
      const email = form.querySelector('[name="email"]').value.trim();
      const message = form.querySelector('[name="message"]').value.trim();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!name || !emailOk || !message) {
        note.textContent = 'Please fill in your name, a valid email, and a message.';
        note.className = 'form-note is-error';
        return;
      }

      note.textContent = "Thanks for reaching out — we'll reply within 1-2 business days.";
      note.className = 'form-note is-success';
      form.reset();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    BuddyNav.init('#site-nav', { active: 'contact' });
    BuddyFooter.init('#site-footer', { showNewsletter: false });
    BuddyCart.initDrawer();
    wireContactForm();
  });
})();
