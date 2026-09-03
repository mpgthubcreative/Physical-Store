/*
 * Asia/Manila calendar arithmetic for reporting date ranges.
 *
 * ---- Why a fixed offset rather than a timezone database ----
 * The Philippines is UTC+08:00 year-round. It has observed no daylight
 * saving time since 1978 and none is scheduled. So a fixed +8h offset is
 * not an approximation here — it is exactly correct, and it avoids
 * depending on the host's ICU/tzdata build (Netlify's Node runtime can ship
 * a trimmed ICU, where Intl timezone conversion silently misbehaves).
 *
 * ---- The bug this module exists to prevent ----
 * An order placed at 11:30pm Manila on Sep 3 is 15:30 UTC on Sep 3 — same
 * date, fine. But an order placed at 12:30am Manila on Sep 4 is 16:30 UTC
 * on Sep 3. Filtering "Sep 4" by UTC calendar days would put that order in
 * the wrong day, and a "Today" report run in the morning Manila time would
 * silently omit the previous evening's orders. Every boundary below is
 * therefore computed as a MANILA civil moment and then converted to the UTC
 * instant Firestore actually stores.
 *
 * ---- Range semantics ----
 * Ranges are half-open in UTC instants: [startUtc, endUtc). The end is the
 * start of the day AFTER the requested end date, so a range is INCLUSIVE of
 * both calendar dates the user picked, with no millisecond gap and no
 * double-counting an order at exactly midnight.
 */
const { ValidationError } = require('./validation');

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PRESETS = ['today', 'week', 'month', 'custom'];

// Guard rails on custom ranges: no reversed ranges, nothing absurd.
const MAX_RANGE_DAYS = 366;
const EARLIEST_YEAR = 2020;

/** Manila civil date parts for a given UTC instant (ms). */
function manilaParts(utcMs) {
  const shifted = new Date(utcMs + MANILA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1, // 1-12
    day: shifted.getUTCDate(),
    // 0 = Sunday .. 6 = Saturday, in Manila civil time
    weekday: shifted.getUTCDay(),
  };
}

/** The UTC instant (ms) at which a given Manila civil date begins (00:00:00 PHT). */
function manilaDateStartUtcMs(year, month, day) {
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) - MANILA_OFFSET_MS;
}

/** "YYYY-MM-DD" for a Manila civil date. */
function formatManilaDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parses "YYYY-MM-DD" strictly — no Date() string parsing, which is implementation-defined. */
function parseDateString(value, fieldName) {
  if (typeof value !== 'string') throw new ValidationError(`${fieldName} must be a date in YYYY-MM-DD format.`);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) throw new ValidationError(`${fieldName} must be a date in YYYY-MM-DD format.`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) throw new ValidationError(`${fieldName} has an invalid month.`);
  if (day < 1 || day > 31) throw new ValidationError(`${fieldName} has an invalid day.`);
  if (year < EARLIEST_YEAR || year > 2100) throw new ValidationError(`${fieldName} is out of the supported range.`);
  // Reject impossible civil dates like 2026-02-30, which Date.UTC would
  // silently roll forward into March.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ValidationError(`${fieldName} is not a real calendar date.`);
  }
  return { year, month, day };
}

/** Adds `days` to a Manila civil date, returning new civil parts. */
function addDays(parts, days) {
  const ms = Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 1, 2026" */
function prettyDate(parts) {
  return `${MONTH_NAMES[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

/** "Sep 1, 2026 – Sep 30, 2026", collapsed to a single date when the range is one day. */
function prettyRange(startParts, endParts) {
  if (startParts.year === endParts.year && startParts.month === endParts.month && startParts.day === endParts.day) {
    return prettyDate(startParts);
  }
  return `${prettyDate(startParts)} – ${prettyDate(endParts)}`;
}

/**
 * Resolves a preset (or a custom From/To pair) into a concrete UTC instant
 * range plus display metadata.
 *
 * Preset definitions, all in Manila civil time:
 *   today  — the current Manila calendar day
 *   week   — Monday through Sunday of the current Manila week (business week)
 *   month  — the 1st of the current Manila month through today
 *   custom — inclusive From..To Manila calendar dates
 *
 * `nowMs` is injectable so this is deterministically testable.
 *
 * @returns {{preset, startDate, endDate, startUtcMs, endUtcMs, label, generatedAtManila}}
 */
function resolveRange({ preset, startDate, endDate, nowMs = Date.now() }) {
  const chosen = preset || 'today';
  if (!PRESETS.includes(chosen)) {
    throw new ValidationError(`preset must be one of: ${PRESETS.join(', ')}.`);
  }

  const today = manilaParts(nowMs);
  let startParts;
  let endParts;

  if (chosen === 'today') {
    startParts = { year: today.year, month: today.month, day: today.day };
    endParts = startParts;
  } else if (chosen === 'week') {
    // Monday-start business week. weekday 0=Sun..6=Sat, so Sunday must look
    // back 6 days, not 0 — the classic off-by-one in week bucketing.
    const daysFromMonday = (today.weekday + 6) % 7;
    startParts = addDays(today, -daysFromMonday);
    endParts = { year: today.year, month: today.month, day: today.day };
  } else if (chosen === 'month') {
    startParts = { year: today.year, month: today.month, day: 1 };
    endParts = { year: today.year, month: today.month, day: today.day };
  } else {
    startParts = parseDateString(startDate, 'From date');
    endParts = parseDateString(endDate, 'To date');
  }

  const startUtcMs = manilaDateStartUtcMs(startParts.year, startParts.month, startParts.day);
  // Half-open: start of the day AFTER the end date.
  const endNext = addDays(endParts, 1);
  const endUtcMs = manilaDateStartUtcMs(endNext.year, endNext.month, endNext.day);

  if (endUtcMs <= startUtcMs) {
    throw new ValidationError('The "To" date must be the same as or after the "From" date.');
  }
  const spanDays = Math.round((endUtcMs - startUtcMs) / DAY_MS);
  if (spanDays > MAX_RANGE_DAYS) {
    throw new ValidationError(`Date range is too large (max ${MAX_RANGE_DAYS} days).`);
  }

  return {
    preset: chosen,
    startDate: formatManilaDate(startParts),
    endDate: formatManilaDate(endParts),
    startUtcMs,
    endUtcMs,
    label: prettyRange(startParts, endParts),
    spanDays,
    generatedAtManila: manilaTimestampLabel(nowMs),
  };
}

/** "Sep 3, 2026 1:41 PM (PHT)" — for the "generated at" line on exports. */
function manilaTimestampLabel(utcMs) {
  const p = manilaParts(utcMs);
  const shifted = new Date(utcMs + MANILA_OFFSET_MS);
  let hours = shifted.getUTCHours();
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${prettyDate(p)} ${hours}:${minutes} ${ampm} (PHT)`;
}

/** "Sep 3, 2026 1:41 PM" for an order row in a report. */
function manilaDateTime(utcMs) {
  return manilaTimestampLabel(utcMs).replace(' (PHT)', '');
}

module.exports = {
  MANILA_OFFSET_MS,
  PRESETS,
  MAX_RANGE_DAYS,
  manilaParts,
  manilaDateStartUtcMs,
  formatManilaDate,
  parseDateString,
  addDays,
  prettyDate,
  prettyRange,
  resolveRange,
  manilaTimestampLabel,
  manilaDateTime,
};
