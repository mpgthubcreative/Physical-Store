/*
 * Dev-only lint helper (not part of the deployed app). Catches the two
 * failure modes `node --check` cannot: an identifier that is USED but never
 * imported (a runtime ReferenceError waiting to happen), and an import that
 * is no longer used after a refactor.
 *
 * Usage: node scripts/check-imports.js
 */
const fs = require('fs');
const path = require('path');

const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

/**
 * Strips COMMENTS only.
 *
 * Deliberately does not strip string literals: a helper is frequently
 * called from inside a template literal (e.g. imageEntities.js builds a
 * Storage path with `${requireString(...)}`), and removing those would
 * report a genuinely-used import as unused. Prose in a comment is the real
 * false-positive risk here, so that is what gets removed.
 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

let problems = 0;

for (const file of walk(FN_DIR)) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');

  const importLines = [...src.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\([^)]*\)/g)];
  const imported = importLines.flatMap((m) =>
    m[1]
      .split(',')
      .map((s) => s.trim().split(':')[0].trim())
      .filter(Boolean)
  );

  // Body = code with the require lines themselves removed.
  let body = src;
  for (const m of importLines) body = body.replace(m[0], '');
  body = codeOnly(body);

  const unused = imported.filter((name) => {
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    return !re.test(body);
  });

  if (unused.length) {
    console.log(`  UNUSED  ${rel} -> ${unused.join(', ')}`);
    problems++;
  }
}

console.log(problems ? `\n${problems} file(s) with unused imports.` : '  OK — no unused imports in netlify/functions.');
process.exit(0);
