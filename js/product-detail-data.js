/**
 * BuddyProductDetail — per-product detail records, including the
 * customizationConfig the customizer engine (js/customizer.js) reads.
 *
 * The engine in customizer.js never hard-codes "Everyday Pouch" — it only
 * ever reads a product's customizationConfig. Adding a second customizable
 * product later means adding a second entry here, nothing in the engine.
 *
 * Coordinate convention (matches customizer.js):
 *  - boundary {top,left,width,height} are percentages of the stage image.
 *  - availablePatches[i].width/height are percentages of the BOUNDARY box
 *    (not the stage), so patch size stays proportional to the customizable
 *    area regardless of the product photo's own crop.
 */
(function () {
  const DETAILS = {
    'everyday-pouch': {
      id: 'pouch',
      slug: 'everyday-pouch',
      name: 'Everyday Pouch',
      basePrice: 260,
      description:
        'Sturdy canvas everyday pouch, handmade to order. Load it up with iron-on patches and add a name to make it fully yours — previewed live above. Ships nationwide in 1–2 working days.',
      variants: [
        { id: 'teal', name: 'Teal', hex: '#38B2B3' },
        { id: 'coral', name: 'Coral', hex: '#F16861' },
        { id: 'mint', name: 'Mint', hex: '#BFDED8' },
        { id: 'cream', name: 'Cream', hex: '#EFE4CC' },
        { id: 'sky', name: 'Sky', hex: '#A7D3E8' },
        { id: 'blush', name: 'Blush', hex: '#F4C4C0' },
      ],
      customizationConfig: {
        boundary: { top: 12, left: 10, width: 80, height: 76 },
        allowText: true,
        textMaxLength: 10,
        textPrice: 30,
        textBoxSize: { width: 46, height: 13 },
        maxPatches: 6,
        availablePatches: [
          { id: 'star', name: 'Star', hex: '#F6C453', price: 40, width: 17, height: 17 },
          { id: 'heart', name: 'Heart', hex: '#F16861', price: 40, width: 17, height: 17 },
          { id: 'rainbow', name: 'Rainbow', hex: '#7FB2E5', price: 40, width: 20, height: 15 },
          { id: 'cloud', name: 'Cloud', hex: '#BFDED8', price: 40, width: 20, height: 14 },
          { id: 'flower', name: 'Flower', hex: '#E88AA6', price: 40, width: 16, height: 16 },
          { id: 'smiley', name: 'Smiley', hex: '#F6C453', price: 40, width: 16, height: 16 },
          { id: 'bolt', name: 'Bolt', hex: '#38B2B3', price: 40, width: 13, height: 19 },
          { id: 'moon', name: 'Moon', hex: '#9B8CD1', price: 40, width: 15, height: 15 },
        ],
      },
    },
  };

  async function getBySlug(slug) {
    return DETAILS[slug] || null;
  }

  window.BuddyProductDetail = { getBySlug };
})();
