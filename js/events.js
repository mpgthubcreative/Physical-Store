/**
 * Events & Parties page: nav/footer + booking-form frontend validation and
 * submission. POST /api/submit-event-inquiry persists the inquiry and
 * enqueues admin + customer emails (Phase 5E) — this file does frontend
 * validation and UI state only; every real validation/anti-abuse rule is
 * re-enforced server-side.
 */
(function () {
  function wireBookingForm() {
    const form = document.querySelector('[data-booking-form]');
    if (!form) return;
    const note = form.querySelector('[data-form-note]');
    const submitBtn = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.querySelector('[name="name"]').value.trim();
      const email = form.querySelector('[name="email"]').value.trim();
      const phone = form.querySelector('[name="phone"]').value.trim();
      const comment = form.querySelector('[name="comment"]').value.trim();
      // Honeypot — a real visitor never sees or fills this field.
      const website = form.querySelector('[name="website"]').value.trim();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!name || !emailOk) {
        note.textContent = 'Please enter your name and a valid email address.';
        note.className = 'form-note is-error';
        return;
      }

      submitBtn.disabled = true;
      note.textContent = '';
      note.className = 'form-note';

      try {
        const res = await fetch('/api/submit-event-inquiry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, phone, comment, website }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          note.textContent = data.error || 'Something went wrong. Please try again.';
          note.className = 'form-note is-error';
          return;
        }

        note.textContent = "Thanks! We've received your event inquiry and will follow up shortly.";
        note.className = 'form-note is-success';
        form.reset();
      } catch (err) {
        note.textContent = 'Something went wrong. Please check your connection and try again.';
        note.className = 'form-note is-error';
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    BuddyNav.init('#site-nav', { active: 'events' });
    BuddyFooter.init('#site-footer', { showNewsletter: false });
    BuddyCart.initDrawer();
    wireBookingForm();
  });
})();
