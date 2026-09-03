/*
 * Reusable Firebase Admin SDK initialization for Netlify Functions.
 *
 * Credentials come ONLY from the FIREBASE_SERVICE_ACCOUNT_JSON environment
 * variable (set in Netlify site settings, never committed). This module is
 * never imported by any frontend/browser file.
 *
 * getAdminApp() is the ONLY place that calls admin.initializeApp(). It
 * safely initializes at most once — admin.apps.length is checked first so
 * a warm Netlify Function invocation reuses the existing default app
 * instead of re-initializing. Every other helper here (getDb, getAdminAuth,
 * getBucket) goes through getAdminApp() first, so the app is always
 * guaranteed to exist before any Firebase service is touched.
 *
 * This is Buddy Patches' OWN Firebase project — a separate service account
 * from Luna Shop's. Never point FIREBASE_SERVICE_ACCOUNT_JSON at Luna's
 * production credentials.
 */
const admin = require('firebase-admin');

function getAdminApp() {
    if (admin.apps.length) {
        return admin.apps[0];
    }

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.');
    }

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(raw);
    } catch (err) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }

    return admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
}

function getDb() {
    return getAdminApp().firestore();
}

function getAdminAuth() {
    return getAdminApp().auth();
}

function getBucket() {
    if (!process.env.FIREBASE_STORAGE_BUCKET) {
        throw new Error('FIREBASE_STORAGE_BUCKET environment variable is not set.');
    }
    return getAdminApp().storage().bucket();
}

module.exports = { admin, getAdminApp, getDb, getAdminAuth, getBucket };
