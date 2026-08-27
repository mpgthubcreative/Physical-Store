/*
 * Consistent JSON response helpers for Netlify Functions.
 * Admin responses are always no-store — this is operational data, never
 * cached at any layer. Public responses (catalog.js) set their own
 * Cache-Control explicitly instead of using these.
 */
const { ValidationError } = require('./validation');

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function ok(body) {
  return json(200, body);
}

function fail(statusCode, error) {
  return json(statusCode, { error });
}

/** Wraps an async handler body: turns ValidationError into 400s and logs
 *  anything unexpected as a 500, so every function doesn't repeat this. */
function withErrorHandling(fn) {
  return async (event, context) => {
    try {
      return await fn(event, context);
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(err.statusCode || 400, err.message);
      }
      console.error('Unhandled function error:', err);
      return fail(500, 'Something went wrong. Please try again.');
    }
  };
}

module.exports = { json, ok, fail, withErrorHandling };
