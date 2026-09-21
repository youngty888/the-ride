#!/usr/bin/env node
/* Re-stamps the ?v= cache-busting tag on the local scripts and stylesheets in index.html
   and auth.html, so riders' phones fetch changed files instead of serving a cached copy.
   Run it before every push that changes a script or stylesheet:

     node scripts/bump-version.js                 (re-stamp every local script/stylesheet)
     node scripts/bump-version.js app.js map.js   (re-stamp only those files)

   Only relative .js/.css references are touched; absolute URLs (fonts, Leaflet) are left
   alone. After writing, it checks that every referenced file exists and exits non-zero if
   not, so a mangled tag can never be committed unnoticed. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = ['index.html', 'auth.html'];
const REF = /((?:src|href)=")([\w./-]+\.(?:js|css))(\?v=[\w.-]*)?(")/g;

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

// Pure: returns the page with tags re-stamped. `only` (array of file names) limits which files.
function bump(html, version, only = []) {
  let out = html.replace(REF, (whole, open, file, _old, close) =>
    (only.length && !only.includes(file)) ? whole : `${open}${file}?v=${version}${close}`);
  if (!only.length) {
    out = out.replace(/<meta name="app-version" content="[^"]*">/, `<meta name="app-version" content="${version}">`);
  }
  return out;
}

function referencedFiles(html) {
  return [...html.matchAll(REF)].map(m => m[2]);
}

function main(argv) {
  const only = argv.filter(a => !a.startsWith('-'));
  const version = stamp();
  let problems = 0, changed = 0;
  const known = new Set();
  for (const page of PAGES) {
    const file = path.join(ROOT, page);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = bump(before, version, only);
    for (const ref of referencedFiles(after)) {
      known.add(ref);
      if (!fs.existsSync(path.join(ROOT, ref))) { console.error(`${page}: references missing file ${ref}`); problems++; }
    }
    if (after !== before) { fs.writeFileSync(file, after); changed++; }
  }
  for (const name of only) {
    if (!known.has(name)) { console.error(`Note: ${name} is not referenced by any page, so nothing was stamped for it.`); problems++; }
  }
  console.log(problems ? `Stamped ${version} with ${problems} problem(s).` : `Stamped version ${version} (${changed} page(s) updated).`);
  return problems ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { bump, stamp, referencedFiles, REF };
