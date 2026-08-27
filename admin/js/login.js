import { signIn } from './admin-auth.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { auth } from './firebase-init.js';
import { setButtonBusy } from './admin-ui.js';

// Already signed in? Skip straight to the dashboard rather than showing the form.
onAuthStateChanged(auth, (user) => {
  if (user) location.href = 'index.html';
});

const form = document.querySelector('[data-login-form]');
const note = document.querySelector('[data-login-note]');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  note.textContent = '';
  note.className = 'admin-note';

  const email = form.email.value.trim();
  const password = form.password.value;
  const submitBtn = form.querySelector('button[type=submit]');
  setButtonBusy(submitBtn, true, 'Signing in…');

  try {
    await signIn(email, password);
    location.href = 'index.html';
  } catch (err) {
    note.textContent = 'Sign-in failed — check your email and password.';
    note.className = 'admin-note is-error';
    setButtonBusy(submitBtn, false);
  }
});
