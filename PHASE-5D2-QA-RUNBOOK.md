# Phase 5D.2 — Migration & QA Runbook

Every command below is run from the project root with Buddy's own service
account available as either:

```
export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

or a gitignored `serviceAccountKey.json` in the project root.

Replace `https://YOURSITE.netlify.app` with the real production URL.

---

## Step 1 — Settings inspection and migration

```
node scripts/inspect-settings-schema.js
node scripts/migrate-settings-5d2.js --dry-run
```

**Do not proceed to `--apply` unless the dry-run shows all of:**

- `project: buddy-shop-45fc4`
- no mention of the `orders` collection (the script cannot write to it)
- `(flatRateDelivery is NOT modified and NOT deleted)`
- `(methods[] is NOT modified and NOT deleted; checkoutEnabled written as false only)`
- rates `luzon: 150`, `visayas: 180`, `mindanao: 200`
- `pickupFee: 0`

If the store already holds a legacy `flatRateDelivery`, the dry-run will say it
is carrying **that** value into all three regions instead of 150/180/200 — this
is deliberate (it preserves current pricing). If you want the approved V1
defaults instead, set them in Admin → Settings → Shipping after deploying.

```
node scripts/migrate-settings-5d2.js --apply
node scripts/verify-phase5d2-predeploy.js
```

`--apply` self-verifies and exits non-zero if anything failed.

---

## Step 2 — Commit and deploy

Done by Claude on your go-ahead. After Netlify finishes, verify:

```
curl -s https://YOURSITE.netlify.app/api/public-settings | json_pp
```

Expect `"checkoutEnabled": false` and the three regional rates.

Then in a browser:
- Admin → Settings loads, banner reads **CHECKOUT DISABLED**
- Admin → Dashboard / Orders / an existing Order Detail all load
- Storefront loads; checkout shows the "not open yet" notice

Or assert it from the CLI:

```
node scripts/qa-tamper-test.js --url https://YOURSITE.netlify.app --expect-closed
```

---

## Step 3 — QA fixtures

```
node scripts/qa-seed-fixtures.js --dry-run
node scripts/qa-seed-fixtures.js --apply
```

Creates `qa-product-pouch` ("ZZ QA Test Pouch", ₱500, variant `qa-teal`, stock
100) and `qa-patch-star` ("ZZ QA Star Patch", ₱40), both `isTest:true`.

The product is created **`active:false`** so no real visitor can reach it. For
the QA window, set it active in Admin → Products, then set it back afterwards.

Normal seeded products/patches are never touched by this script.

---

## Step 4 — Temporary QA payment settings

In **Admin → Settings → Payments** (as Owner), enter clearly-labelled test data:

| Field | Value |
|---|---|
| GCash account name | `ZZ QA TEST — DO NOT SEND REAL MONEY` |
| GCash mobile number | `0917 000 0000` |
| GCash instructions | `QA TEST — DO NOT SEND REAL MONEY` |
| Bank name | `ZZ QA TEST BANK` |
| Bank account name | `ZZ QA TEST — DO NOT SEND REAL MONEY` |
| Bank account number | `0000 0000 0000` |
| Bank instructions | `QA TEST — DO NOT SEND REAL MONEY` |

Enable both. On the Shipping tab confirm 150 / 180 / 200 / pickup 0.

**Leave checkout DISABLED.** Never put service-account credentials anywhere in Admin.

---

## Step 5 — Open the QA window

Admin → Settings → Payments → checkout master switch → on. Confirm the dialog.
Banner must flip to **CHECKOUT LIVE**.

---

## Steps 6 + 7 — Checkout, shipping, and tampering

```
node scripts/qa-tamper-test.js \
  --url https://YOURSITE.netlify.app \
  --product qa-product-pouch --variant qa-teal
```

This covers Step 6 (pickup ₱0, Luzon ₱150, Visayas ₱180, Mindanao ₱200, stored
totals match) and Step 7 (forged `shippingFee`/`total`/`subtotal`/`pricing`
ignored; invalid region rejected; missing region rejected; region ignored on
pickup).

**It prints the order numbers it created — keep them for Step 17.**

Then do one manual browser checkout to confirm the UI itself (region selector,
barangay field, `Subtotal / Shipping — Region / Total to Pay`).

---

## Steps 8–12 — Payment and fulfillment lifecycle (browser)

These need the real Admin UI. Using QA orders only:

1. **GCash** — submit payer name + reference. Confirm `awaiting_payment →
   pending_review` and reservation `active → locked`. Order Detail must show
   amount expected, subtotal, shipping, total, method, payer, reference,
   submitted time, Approve, Reject.
2. **Bank Transfer** — repeat on a second QA order.
3. **Reject** one with a reason. Confirm `pending_review → rejected`,
   reservation `locked → active` with a fresh TTL, customer can resubmit, and
   **both** attempts remain in the history.
4. **Approve** one. Confirm `paid`, reservation `consumed`, `reservedQty` down,
   `stockQty` permanently down. Double-click Approve / retry — the second must
   fail with a 409, not deduct twice.
5. **Pickup order**: Unfulfilled → Processing → Ready for Pickup → Completed.
   Confirm an unpaid order cannot leave Unfulfilled.
6. **Delivery order**: Unfulfilled → Processing → Shipped (courier **required**,
   tracking optional) → Completed. Confirm courier/tracking survive the move to
   Completed, and that a pickup order can never be marked Shipped.

---

## Step 13 — Permissions

As a non-Owner **Admin** account:
- Admin → Settings → Payments must be view-only (banner explains why)
- Shipping must be editable

Prove the server enforces it independently of the UI — with an Admin ID token:

```
curl -i -X POST https://YOURSITE.netlify.app/api/admin-save-payment-settings \
  -H "Authorization: Bearer <ADMIN_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"checkoutEnabled":true,"gcash":{"enabled":true},"bank":{"enabled":false}}'
```

Expect **403**. Repeat against `/api/admin-save-shipping-settings` with a valid
shipping body — expect **200**.

---

## Step 14 — Historical compatibility

```
node scripts/verify-phase5d2-predeploy.js
```

Reports orders lacking `destinationRegion` / `barangay` / `courier` and prints
each order's stored subtotal/shipping/total. Compare against the run from Step 1
— **the numbers must be identical.** Also open two historical orders in Admin
and confirm they render with "Not recorded" rather than errors.

---

## Step 15 — UI / mobile

Desktop plus 428 / 390 / 375 / 320 px on: Admin Settings, Orders, Order Detail
(Payment Review + Fulfillment), customer Checkout, customer payment page.
Confirm no page-level horizontal overflow.

---

## Step 16 — CLOSE THE WINDOW (do this immediately after QA)

```
node scripts/qa-close-window.js --url https://YOURSITE.netlify.app --disable-methods
```

Writes `checkoutEnabled:false`, then proves it three independent ways: Firestore
directly, `/api/public-settings`, and a real `create-order` attempt that must be
refused with `503 CHECKOUT_DISABLED`. Use `--clear-methods` to also blank the QA
account details. QR paths and legacy `methods[]` are preserved either way.

---

## Step 17 — Cleanup

```
node scripts/qa-mark-orders-as-test.js --dry-run --orders BP-XXX,BP-YYY
node scripts/qa-mark-orders-as-test.js --apply   --orders BP-XXX,BP-YYY

node scripts/qa-seed-fixtures.js --remove     # only if delete protection allows

node scripts/qa-cleanup-verify.js
```

`qa-cleanup-verify.js` is read-only and confirms: checkout off, every QA order
marked `isTest:true`, no QA reservation still active/locked, no real catalog item
left holding reserved stock, no negative stock, and historical pricing intact.

If a QA fixture cannot be deleted because a historical order references it, that
is the delete-protection working correctly — leave it archived (`active:false`)
rather than forcing removal.

---

## Rollback

Nothing in this phase is destructive to existing data. If something looks wrong:

1. `node scripts/qa-close-window.js --url ... --disable-methods` (stops orders immediately)
2. `git revert <commit>` and redeploy — the settings docs keep both shapes, so
   the previous code reads them correctly with no data change required.
