/*
 * Email templates — one render function per lifecycle type, sharing a
 * single branded wrapper. Inline CSS throughout: external stylesheets
 * don't render in email clients. Font stack falls back to system fonts
 * rather than relying on Google Fonts loading inside an inbox — the
 * webfont names are listed first for clients that do render them, but
 * nothing here depends on that.
 *
 * Colors match css/style.css exactly (--ink #2C4A4A, --teal #38B2B3,
 * --coral #F16861, --panel #F4F8F6, --border #E4EEEA).
 *
 * Every render function returns { subject, html } and takes plain data —
 * no Firestore access, no token generation, no knowledge of transport.
 * The processor is responsible for building `orderLink` (if any) before
 * calling in here; templates only format content.
 */

const INK = '#2C4A4A';
const INK_MUTED = '#5A7370';
const TEAL = '#38B2B3';
const CORAL = '#F16861';
const PANEL = '#F4F8F6';
const BORDER = '#E4EEEA';
const FONT_HEADING = "'Quicksand', Verdana, Geneva, sans-serif";
const FONT_BODY = "'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The one shared wrapper every template renders inside. */
function wrap({ title, bodyHtml, footerNote }) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${PANEL};font-family:${FONT_BODY};">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:${INK};border-radius:16px 16px 0 0;padding:20px 28px;">
      <span style="font-family:${FONT_HEADING};font-weight:700;font-size:20px;color:#FFFFFF;">Buddy Patches</span>
    </div>
    <div style="background:#FFFFFF;border:1px solid ${BORDER};border-top:none;border-radius:0 0 16px 16px;padding:28px;">
      ${bodyHtml}
    </div>
    <p style="font-size:12px;color:${INK_MUTED};text-align:center;margin:18px 8px 0;line-height:1.6;">
      ${footerNote || 'This is a transactional message about your Buddy Patches order.'}<br>
      Buddy Patches &middot; buddypatches.ph
    </p>
  </div>
</body>
</html>`;
}

function button(label, href) {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${CORAL};color:#FFFFFF;text-decoration:none;font-family:${FONT_BODY};font-weight:700;font-size:14px;padding:12px 24px;border-radius:999px;margin-top:16px;">${escapeHtml(label)}</a>`;
}

function heading(text) {
  return `<h1 style="font-family:${FONT_HEADING};font-weight:700;font-size:22px;color:${INK};margin:0 0 12px;">${escapeHtml(text)}</h1>`;
}

function para(text) {
  return `<p style="font-family:${FONT_BODY};font-size:14.5px;color:${INK_MUTED};line-height:1.6;margin:0 0 14px;">${text}</p>`;
}

function amountBox(label, value) {
  return `<div style="background:${PANEL};border-radius:12px;padding:14px 18px;margin:16px 0;">
    <div style="font-family:${FONT_BODY};font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${INK_MUTED};">${escapeHtml(label)}</div>
    <div style="font-family:${FONT_HEADING};font-weight:700;font-size:26px;color:${INK};margin-top:4px;">${escapeHtml(value)}</div>
  </div>`;
}

function pricingRows({ subtotal, shippingFee, total }) {
  return `<div style="border-top:1px dashed ${BORDER};margin-top:14px;padding-top:12px;font-family:${FONT_BODY};font-size:13.5px;color:${INK_MUTED};">
    <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Items subtotal</span><span>${money(subtotal)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Shipping</span><span>${shippingFee > 0 ? money(shippingFee) : 'Free'}</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0 0;font-weight:700;color:${INK};"><span>Total</span><span>${money(total)}</span></div>
  </div>`;
}

/* ============================= Customer ============================= */

function orderCreated({ orderNumber, customerName, subtotal, shippingFee, total, deliveryMethod, destinationLabel }, orderLink) {
  const deliveryLine = deliveryMethod === 'pickup' ? 'Pickup' : `Delivery — ${escapeHtml(destinationLabel || '')}`;
  return {
    subject: `Order ${orderNumber} received — Buddy Patches`,
    html: wrap({
      title: `Order ${orderNumber} received`,
      bodyHtml: `
        ${heading('Thanks for your order!')}
        ${para(`Hi ${escapeHtml(customerName)}, we've received your order <strong>${escapeHtml(orderNumber)}</strong> (${escapeHtml(deliveryLine)}).`)}
        ${amountBox('Amount to Pay', money(total))}
        ${pricingRows({ subtotal, shippingFee, total })}
        ${para('Send your payment, then submit your reference number using the link below so we can confirm it.')}
        ${button('View order & pay', orderLink)}
      `,
    }),
  };
}

function paymentSubmitted({ orderNumber, customerName, paymentMethod, paymentReference, total }, orderLink) {
  return {
    subject: `Payment submitted for order ${orderNumber} — under review`,
    html: wrap({
      title: 'Payment submitted',
      bodyHtml: `
        ${heading('Payment submitted for review')}
        ${para(`Hi ${escapeHtml(customerName)}, we've received your ${escapeHtml(paymentMethod)} reference <strong>${escapeHtml(paymentReference)}</strong> for order <strong>${escapeHtml(orderNumber)}</strong> (${money(total)}).`)}
        ${para("We'll verify it against our records and confirm shortly.")}
        ${button('Check order status', orderLink)}
      `,
    }),
  };
}

function paymentRejected({ orderNumber, customerName, reasonLabel, reasonNote, total }, orderLink) {
  return {
    subject: `Action needed — payment for order ${orderNumber} could not be confirmed`,
    html: wrap({
      title: 'Payment not confirmed',
      bodyHtml: `
        ${heading('We could not confirm your payment')}
        ${para(`Hi ${escapeHtml(customerName)}, your last payment submission for order <strong>${escapeHtml(orderNumber)}</strong> (${money(total)}) was not accepted: <strong>${escapeHtml(reasonLabel)}</strong>${reasonNote ? ' — ' + escapeHtml(reasonNote) : ''}.`)}
        ${para('Please review and submit a new reference number — your items are still reserved for you.')}
        ${button('Resubmit payment', orderLink)}
      `,
    }),
  };
}

function paymentApproved({ orderNumber, customerName, total }, orderLink) {
  return {
    subject: `Payment confirmed for order ${orderNumber}`,
    html: wrap({
      title: 'Payment confirmed',
      bodyHtml: `
        ${heading('Payment confirmed!')}
        ${para(`Hi ${escapeHtml(customerName)}, we've confirmed your payment of ${money(total)} for order <strong>${escapeHtml(orderNumber)}</strong>. We're getting it ready.`)}
        ${button('View order', orderLink)}
      `,
    }),
  };
}

function reservationExpired({ orderNumber, customerName }, orderLink) {
  return {
    subject: `Your reservation for order ${orderNumber} has expired`,
    html: wrap({
      title: 'Reservation expired',
      bodyHtml: `
        ${heading('Your items were released')}
        ${para(`Hi ${escapeHtml(customerName)}, the reservation for order <strong>${escapeHtml(orderNumber)}</strong> expired before payment was received, so those items are no longer held.`)}
        ${para('If they\'re still available, you can try reserving them again from the link below.')}
        ${button('Try to reserve again', orderLink)}
      `,
    }),
  };
}

function fulfillmentProcessing({ orderNumber, customerName }, orderLink) {
  return {
    subject: `Order ${orderNumber} is being processed`,
    html: wrap({
      title: 'Order processing',
      bodyHtml: `
        ${heading('Your order is being processed')}
        ${para(`Hi ${escapeHtml(customerName)}, we've started preparing order <strong>${escapeHtml(orderNumber)}</strong>.`)}
        ${button('View order', orderLink)}
      `,
    }),
  };
}

function fulfillmentReady({ orderNumber, customerName }, orderLink) {
  return {
    subject: `Order ${orderNumber} is ready for pickup`,
    html: wrap({
      title: 'Ready for pickup',
      bodyHtml: `
        ${heading('Ready for pickup!')}
        ${para(`Hi ${escapeHtml(customerName)}, order <strong>${escapeHtml(orderNumber)}</strong> is ready whenever you are.`)}
        ${button('View order', orderLink)}
      `,
    }),
  };
}

function fulfillmentShipped({ orderNumber, customerName, courier, trackingNumber }, orderLink) {
  const trackingLine = courier
    ? `Shipped via <strong>${escapeHtml(courier)}</strong>${trackingNumber ? ` — tracking <strong>${escapeHtml(trackingNumber)}</strong>` : ''}.`
    : 'Your order is on its way.';
  return {
    subject: `Order ${orderNumber} has shipped`,
    html: wrap({
      title: 'Order shipped',
      bodyHtml: `
        ${heading('Your order shipped!')}
        ${para(`Hi ${escapeHtml(customerName)}, order <strong>${escapeHtml(orderNumber)}</strong> is on its way. ${trackingLine}`)}
        ${button('View order', orderLink)}
      `,
    }),
  };
}

function fulfillmentCompleted({ orderNumber, customerName }, orderLink) {
  return {
    subject: `Order ${orderNumber} completed — thank you!`,
    html: wrap({
      title: 'Order completed',
      bodyHtml: `
        ${heading('Thank you!')}
        ${para(`Hi ${escapeHtml(customerName)}, order <strong>${escapeHtml(orderNumber)}</strong> is complete. We hope you love it!`)}
        ${button('View order', orderLink)}
      `,
    }),
  };
}

/* ============================== Admin ============================== */

function adminNewOrder({ orderNumber, customerName, total, deliveryMethod, destinationLabel }) {
  const deliveryLine = deliveryMethod === 'pickup' ? 'Pickup' : `Delivery — ${escapeHtml(destinationLabel || '')}`;
  return {
    subject: `New order ${orderNumber} — ${money(total)}`,
    html: wrap({
      title: 'New order placed',
      footerNote: 'Admin notification — sign in to the Buddy Admin to review.',
      bodyHtml: `
        ${heading('New order placed')}
        ${para(`<strong>${escapeHtml(orderNumber)}</strong> from ${escapeHtml(customerName)} — ${money(total)} (${escapeHtml(deliveryLine)}). Not yet paid.`)}
      `,
    }),
  };
}

function adminPaymentReview({ orderNumber, customerName, paymentMethod, paymentReference, total }) {
  return {
    subject: `Payment requires review — order ${orderNumber}`,
    html: wrap({
      title: 'Payment requires review',
      footerNote: 'Admin notification — sign in to the Buddy Admin to approve or reject.',
      bodyHtml: `
        ${heading('Payment awaiting review')}
        ${para(`<strong>${escapeHtml(orderNumber)}</strong> from ${escapeHtml(customerName)} — ${money(total)} via ${escapeHtml(paymentMethod)}, ref <strong>${escapeHtml(paymentReference)}</strong>.`)}
      `,
    }),
  };
}

function adminEventInquiry({ name, email, phone, comment }) {
  return {
    subject: `New Events & Parties inquiry from ${name}`,
    html: wrap({
      title: 'New event inquiry',
      footerNote: 'Admin notification — sign in to the Buddy Admin to follow up.',
      bodyHtml: `
        ${heading('New event inquiry')}
        ${para(`<strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt;${phone ? ' · ' + escapeHtml(phone) : ''}`)}
        ${para(escapeHtml(comment).replace(/\n/g, '<br>'))}
      `,
    }),
  };
}

function inquiryReceived({ name }) {
  return {
    subject: 'We received your Events & Parties inquiry — Buddy Patches',
    html: wrap({
      title: 'Inquiry received',
      bodyHtml: `
        ${heading('Thanks for reaching out!')}
        ${para(`Hi ${escapeHtml(name)}, we've received your Events & Parties inquiry and will follow up within 1-2 business days.`)}
      `,
    }),
  };
}

/* Maps outbox `type` directly to its render function. */
const RENDERERS = {
  'order-created': orderCreated,
  'payment-submitted': paymentSubmitted,
  'payment-rejected': paymentRejected,
  'payment-approved': paymentApproved,
  'reservation-expired': reservationExpired,
  'fulfillment-processing': fulfillmentProcessing,
  'fulfillment-ready': fulfillmentReady,
  'fulfillment-shipped': fulfillmentShipped,
  'fulfillment-completed': fulfillmentCompleted,
  'order-admin-new': adminNewOrder,
  'payment-admin-review': adminPaymentReview,
  'event-inquiry-admin': adminEventInquiry,
  'event-inquiry-customer': inquiryReceived,
};

/** Renders the correct template for an outbox document's `type`. `orderLink` is null for admin/inquiry emails. */
function renderEmail(type, payload, orderLink) {
  const renderer = RENDERERS[type];
  if (!renderer) throw new Error(`No email template for type "${type}".`);
  return renderer(payload, orderLink);
}

module.exports = { renderEmail, RENDERERS, escapeHtml, money };
