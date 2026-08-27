/**
 * Firebase client SDK init — Auth only (Firestore/Storage stay server-only,
 * read/written exclusively through the Netlify Functions in netlify/functions/).
 *
 * This config is NOT a secret — Firebase's web config is meant to be public
 * (it's protected by security rules + domain restrictions, not secrecy).
 * The Admin SDK service-account credential is a completely different thing
 * and lives only in Netlify's server-side environment variables, never here.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCIniVlZOIhU0wCecqZV0QF7sB5qkJ4moA',
  authDomain: 'buddy-shop-45fc4.firebaseapp.com',
  projectId: 'buddy-shop-45fc4',
  storageBucket: 'buddy-shop-45fc4.firebasestorage.app',
  messagingSenderId: '820683091626',
  appId: '1:820683091626:web:875b25c18b082eacd32ad3',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
