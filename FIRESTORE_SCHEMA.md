<!-- Phase 5A schema proposal. Design only — none of these collections are
populated yet. Field shapes will get refined in 5B (catalog/admin) and
5C/5D (orders/inventory) as those phases are actually built; this is the
agreed starting point, not a frozen spec. -->

# Buddy Patches — Firestore Schema Proposal

All collections are top-level (no subcollections) — the data model is small
enough that nesting would only add query complexity without a real benefit
yet. Every write goes through a Netlify Function using the Admin SDK;
Firestore rules stay default-deny (see `firestore.rules`).

## `products/{productId}`

```js
{
  slug: "everyday-pouch",
  title: "Everyday Pouch",
  description: "Sturdy canvas everyday pouch, handmade to order...",
  category: "pouches",
  collectionIds: ["col_abc123"],           // -> collections/{id}
  basePrice: 260,
  thumbnail: "product-images/everyday-pouch/thumb.jpg",
  gallery: ["product-images/everyday-pouch/1.jpg", "..."],
  featured: true,
  active: true,

  customizable: true,
  customizationConfig: {                    // present only if customizable
    boundary: { top: 12, left: 10, width: 80, height: 76 },  // % of stage image
    allowText: true,
    textMaxLength: 10,
    textPrice: 30,
    textBoxSize: { width: 46, height: 13 },  // % of boundary, for clamping
    maxPatches: 6,                           // total physical instances, not distinct types
    availablePatchIds: ["patch_heart", "patch_star", "..."],  // -> patches/{id}
  },

  variants: [
    {
      variantId: "teal",
      name: "Teal",
      hex: "#38B2B3",
      sku: "POUCH-TEAL",
      stockQty: 40,
      lowStockThreshold: 5,
      active: true,
      thumbnail: "product-images/everyday-pouch/teal.jpg",
    },
    // ...
  ],

  createdAt, updatedAt,
}
```

Variants are embedded (not a subcollection) — a handful of color options per
product, always read/written together with the product, never queried
independently. Stock lives per-variant here.

## `patches/{patchId}`

Patches are their own catalog, normalized out of `products`, because the
same physical patch (e.g. "Heart") can be offered on more than one
customizable product and has its own independent stock — a product's
`customizationConfig.availablePatchIds` only references which patches it
offers and how many total instances it allows; price/appearance/stock live
here once.

```js
{
  name: "Heart",
  hex: "#F16861",              // swatch/placeholder color until real photos exist
  image: "patch-images/heart.jpg",
  price: 40,                   // added per instance placed
  displayWidthPct: 17,         // % of a customizer boundary, default display size
  displayHeightPct: 17,
  stockQty: 120,
  lowStockThreshold: 15,
  active: true,
  createdAt, updatedAt,
}
```

## `collections/{collectionId}` — *recommended addition*

`products.collectionIds` already implies these exist; not in your original
list but needed for the Catalog page's "Home / Collections" breadcrumb and
for admin collection management mentioned earlier in this project.

```js
{
  name: "Everyday Carry",
  slug: "everyday-carry",
  description: "...",
  image: "collection-images/everyday-carry.jpg",
  active: true,
  createdAt, updatedAt,
}
```

## `orders/{orderId}`

The customization snapshot is preserved **exactly** as approved — every
patch instance, position, and z-order, plus the text layer's position and
z — so Customizer → Cart → Order → Admin Preview all reconstruct the same
design. `z` is not derived or re-sorted anywhere downstream; it's stored
verbatim from the cart line.

```js
{
  orderNumber: "BP-4F7K2Q",
  accessTokenHash: "sha256 hex...",   // raw token never stored — same pattern as Luna

  customer: { firstName, lastName, email, mobile },
  shippingMethod: "metro-manila" | "provincial" | "pickup",
  shippingAddress: {                   // null when shippingMethod is "pickup"
    address, barangay, city, province, postalCode,
  },
  shippingFee: 80,

  items: [
    {
      productId, productTitle,          // productTitle is a snapshot — see note below
      variantId, variantName,
      quantity: 1,
      unitPrice: 330,                   // server-computed at order time, never trusted from client
      lineTotal: 330,

      customization: {                  // null for non-customizable products
        variantId: "teal",
        text: "JOY",
        textPosition: { x: 50, y: 85 },
        textZ: 4,
        patches: [
          { patchId: "patch_heart", x: 34.2, y: 58.1, z: 2 },
          { patchId: "patch_heart", x: 60.0, y: 40.5, z: 3 },  // same patch, 2nd instance
          { patchId: "patch_star",  x: 70.0, y: 30.0, z: 1 },
        ],
      },
    },
  ],

  subtotal: 330,
  total: 410,

  paymentMethod: "gcash" | "maya" | "bank-transfer",
  paymentReference: "1234567890" | null,
  paymentStatus: "awaiting_payment" | "pending_review" | "paid" | "rejected" | "refunded",
  fulfillmentStatus: "unfulfilled" | "processing" | "packed" | "shipped" | "delivered" | "cancelled",
  courier: null,
  trackingNumber: null,

  statusHistory: [                      // recommended addition — admin audit trail
    { status: "awaiting_payment", changedBy: "system", changedAt, note: null },
  ],

  createdAt, updatedAt,
}
```

`productTitle`/`variantName`/patch names are **not** re-embedded per line
beyond what's shown above (patch objects store only `patchId` + position +
z, not a name snapshot) — worth deciding in 5C whether patch display names
should also be snapshotted, since editing a patch's name later would
otherwise change how old orders display it. Flagging now, not deciding yet.

## `inventoryReservations/{reservationId}`

Backs the "soft-reserve at order creation, hard-deduct at payment approval"
strategy already agreed in principle (not implemented until 5D).

```js
{
  orderId,
  items: [
    { kind: "variant", refId: "POUCH-TEAL", qty: 1 },
    { kind: "patch", refId: "patch_heart", qty: 2 },
  ],
  status: "active" | "released" | "consumed",
  expiresAt: timestamp,
  createdAt,
}
```

## `adminUsers/{uid}`

Identical shape to Luna's, doc ID = Firebase Auth `uid`.

```js
{
  uid, email, displayName,
  role: "owner" | "admin",
  status: "active" | "disabled",
  createdAt, createdBy, updatedAt, updatedBy,
}
```

## `eventInquiries/{inquiryId}`

Backs the Events & Parties booking form (frontend already built in Phase 2;
not wired to a backend yet).

```js
{
  name, email, phone, comment,
  status: "new" | "contacted" | "closed",
  createdAt,
}
```

## `siteSettings/{doc}` — *recommended, optional*

A single doc (e.g. `siteSettings/general`) for values that would otherwise
get hardcoded across multiple Netlify Functions and the frontend: shipping
fee table, free-shipping threshold, promo bar text. Not required for V1 —
flagging as a later convenience, not proposing to build it now.

---

## What's intentionally NOT in this proposal

- No digital-delivery fields anywhere (no `productFiles`, download tokens,
  `paid-products` storage path). Buddy sells physical goods only.
- No subcollections yet — flat collections are enough at this scale.
- No `carts` collection — the cart stays frontend-only (localStorage) until
  checkout; a Firestore cart doc isn't needed for a guest-checkout flow.
