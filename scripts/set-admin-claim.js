/*
 * ONE-TIME LOCAL SCRIPT.
 *
 * Grants the admin:true (+ role) custom claim to a Firebase Auth user,
 * identified by UID or email, and upserts the matching adminUsers/{uid}
 * metadata doc. This is the ONLY way an Owner account is ever created —
 * there is no public signup page, and no HTTP endpoint does this, anywhere
 * in this project. It only runs if the caller already holds
 * FIREBASE_SERVICE_ACCOUNT_JSON (or a local serviceAccountKey.json), so it
 * can never be invoked remotely.
 *
 * Usage:
 *   node scripts/set-admin-claim.js <uid-or-email> [role]
 *
 * role defaults to "admin". To create Buddy's first Owner account, run:
 *   node scripts/set-admin-claim.js <your-email> owner
 *
 * Credentials: set FIREBASE_SERVICE_ACCOUNT_JSON in your shell, or drop a
 * serviceAccountKey.json file (gitignored) next to this script. Use
 * BUDDY'S OWN service account — never Luna Shop's.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const VALID_ROLES = ['owner', 'admin'];

function loadServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    }

    const localKeyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
    if (fs.existsSync(localKeyPath)) {
        return JSON.parse(fs.readFileSync(localKeyPath, 'utf8'));
    }

    console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or add serviceAccountKey.json.');
    process.exit(1);
}

async function main() {
    const identifier = process.argv[2];
    const role = process.argv[3] || 'admin';

    if (!identifier) {
        console.error('Usage: node scripts/set-admin-claim.js <uid-or-email> [role]');
        process.exit(1);
    }
    if (!VALID_ROLES.includes(role)) {
        console.error(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(', ')}.`);
        process.exit(1);
    }

    const serviceAccount = loadServiceAccount();
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }

    const user = identifier.includes('@')
        ? await admin.auth().getUserByEmail(identifier)
        : await admin.auth().getUser(identifier);

    if (role === 'owner') {
        const db = admin.firestore();
        const existingOwners = await db.collection('adminUsers').where('role', '==', 'owner').get();
        const alreadyOwner = existingOwners.docs.some((d) => d.id === user.uid);
        if (!existingOwners.empty && !alreadyOwner) {
            console.error(
                'A protected Owner already exists (' +
                    existingOwners.docs.map((d) => d.data().email).join(', ') +
                    '). This project supports exactly one Owner for now — Owner transfer is not implemented.'
            );
            process.exit(1);
        }
    }

    await admin.auth().setCustomUserClaims(user.uid, { admin: true, role });

    const db = admin.firestore();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const existingDoc = await db.collection('adminUsers').doc(user.uid).get();
    await db
        .collection('adminUsers')
        .doc(user.uid)
        .set(
            {
                uid: user.uid,
                email: user.email,
                displayName: user.displayName || existingDoc.data()?.displayName || user.email,
                role,
                status: 'active',
                createdAt: existingDoc.exists ? existingDoc.data().createdAt : now,
                createdBy: existingDoc.exists ? existingDoc.data().createdBy : 'bootstrap-script',
                updatedAt: now,
                updatedBy: 'bootstrap-script',
            },
            { merge: true }
        );

    console.log(`Granted {admin:true, role:"${role}"} to ${user.email} (${user.uid}).`);
    console.log('They must sign out and sign back in for the new claim to take effect.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Failed to set admin claim:', err);
    process.exit(1);
});
