/*
 * Safety guard for automated/agent-driven destructive QA testing —
 * NOT part of the production admin bundle, never loaded by any real page.
 * Exists so a delete-endpoint call made by a test script/agent session can
 * be programmatically refused if the target record doesn't unambiguously
 * look like disposable QA data.
 *
 * A record counts as QA-safe if EITHER:
 *   - its id/slug starts with "qa-" (case-insensitive), or
 *   - its name/title starts with "ZZ QA" (the convention already used
 *     throughout this project's manual QA passes), or
 *   - it carries an explicit `isTest: true` field.
 *
 * This is a testing-tooling safeguard only — it must never be wired into
 * the real Owner-authorization path (admin-delete-product.js etc. keep
 * deciding permission on their own via requireOwner() + the historical-
 * order-reference check, completely independent of this file). This guard
 * only prevents an automated test script from CALLING a destructive
 * endpoint against something that isn't obviously disposable — it adds a
 * check before the call, it does not change what the server allows.
 */
const QA_ID_PREFIX = /^qa-/i;
const QA_NAME_PREFIX = /^ZZ QA/;

function isQaTestRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.isTest === true) return true;
  const id = String(record.id || record.slug || '');
  if (QA_ID_PREFIX.test(id)) return true;
  const label = String(record.name || record.title || '');
  if (QA_NAME_PREFIX.test(label)) return true;
  return false;
}

/** Throws if `record` doesn't pass isQaTestRecord — call this immediately before any destructive delete call in a test script. */
function assertQaTestRecord(record, context) {
  if (!isQaTestRecord(record)) {
    throw new Error(
      `Refusing destructive test action${context ? ` (${context})` : ''}: record "${record && (record.id || record.slug)}" ` +
        `does not look like disposable QA data (expected id/slug starting with "qa-", name/title starting with "ZZ QA", or isTest:true). ` +
        `This guard exists specifically to stop an automated test from deleting real/seeded records.`
    );
  }
}

module.exports = { isQaTestRecord, assertQaTestRecord };
