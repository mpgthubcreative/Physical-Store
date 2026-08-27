/**
 * Events & Parties page: nav/footer + booking-form frontend validation only.
 * No backend yet — Phase 3+ wires this to a Firestore-backed submission
 * with an optional Resend admin notification.
 */
(function () {
  function wireBookingForm() {
    const form = document.querySelector('[data-booking-form]');
    if (!form) return;
    const note = form.querySelector('[data-form-note]');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = form.querySelector('[name="name"]').value.trim();
      const email = form.querySelector('[name="email"]').value.trim();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!name || !emailOk) {
        note.textContent = 'Please enter your name and a valid email address.';
        note.className = 'form-note is-error';
        return;
      }

      note.textContent = "Thanks! We've received your event inquiry and will follow up shortly.";
      note.className = 'form-note is-success';
      form.reset();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    BuddyNav.init('#site-nav', { active: 'events' });
    BuddyFooter.init('#site-footer', { showNewsletter: false });
    BuddyCart.initDrawer();
    wireBookingForm();
  });
})();
