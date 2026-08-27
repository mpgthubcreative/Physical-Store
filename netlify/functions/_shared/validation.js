/*
 * Shared server-side validation helpers for admin-* Netlify Functions.
 * Every admin write goes through these — never trust the browser just
 * because a request is authenticated as an admin.
 */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function requireString(value, fieldName, { maxLength = 500, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${fieldName} must be a string.`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) throw new ValidationError(`${fieldName} is required.`);
  if (trimmed.length > maxLength) throw new ValidationError(`${fieldName} must be ${maxLength} characters or fewer.`);
  return trimmed;
}

function optionalString(value, fieldName, opts = {}) {
  if (value == null || value === '') return '';
  return requireString(value, fieldName, { ...opts, allowEmpty: true });
}

function requireNumber(value, fieldName, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(`${fieldName} must be a number.`);
  if (integer && !Number.isInteger(n)) throw new ValidationError(`${fieldName} must be a whole number.`);
  if (n < min || n > max) throw new ValidationError(`${fieldName} must be between ${min} and ${max}.`);
  return n;
}

function requireBoolean(value, fieldName) {
  if (typeof value !== 'boolean') throw new ValidationError(`${fieldName} must be true or false.`);
  return value;
}

function requirePercent(value, fieldName) {
  return requireNumber(value, fieldName, { min: 0, max: 100 });
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
function requireHex(value, fieldName) {
  const s = requireString(value, fieldName, { maxLength: 7 });
  if (!HEX_RE.test(s)) throw new ValidationError(`${fieldName} must be a hex color like #38B2B3.`);
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function requireEmail(value, fieldName = 'Email') {
  const s = requireString(value, fieldName, { maxLength: 200 });
  if (!EMAIL_RE.test(s)) throw new ValidationError(`${fieldName} must be a valid email address.`);
  return s.toLowerCase();
}

function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function requireArray(value, fieldName, { maxLength = 200 } = {}) {
  if (!Array.isArray(value)) throw new ValidationError(`${fieldName} must be an array.`);
  if (value.length > maxLength) throw new ValidationError(`${fieldName} may have at most ${maxLength} items.`);
  return value;
}

/** Throws if any array contains duplicate values (used for variantId/patchId uniqueness within one product). */
function requireNoDuplicates(values, fieldName) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) throw new ValidationError(`Duplicate ${fieldName}: "${v}".`);
    seen.add(v);
  }
}

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
function requireImageContentType(value) {
  if (!ALLOWED_IMAGE_TYPES.has(value)) {
    throw new ValidationError(`Unsupported image type "${value}". Allowed: ${[...ALLOWED_IMAGE_TYPES].join(', ')}.`);
  }
  return value;
}

module.exports = {
  ValidationError,
  requireString,
  optionalString,
  requireNumber,
  requireBoolean,
  requirePercent,
  requireHex,
  requireEmail,
  slugify,
  requireArray,
  requireNoDuplicates,
  requireImageContentType,
  ALLOWED_IMAGE_TYPES,
};
