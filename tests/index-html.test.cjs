// Guards index.html against a broken script/stylesheet tag (an earlier version-bump
// script mangled "poi.js?v=123" into "poi.=123", which would have broken the whole app).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const pages = ['index.html', 'auth.html'];

function localRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"[^>]*>/g)) {
    const url = m[1];
    if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
    if (/rel="(preconnect|stylesheet)"/.test(m[0]) && !/\.(css)(\?|$)/.test(url)) continue;
    refs.push(url);
  }
  return refs;
}

for (const page of pages) {
  test(`${page}: every local script and stylesheet points at a real file`, () => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const refs = localRefs(html);
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      const file = ref.split('?')[0];
      assert.match(file, /\.(js|css)$/, `${page}: malformed reference "${ref}"`);
      assert.ok(fs.existsSync(path.join(root, file)), `${page}: missing file ${file}`);
    }
  });
  test(`${page}: local scripts and stylesheets carry a version tag`, () => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    for (const ref of localRefs(html)) assert.match(ref, /\?v=[\w.-]+$/, `${page}: no ?v= on ${ref}`);
  });
}

test('index.html loads every module the app depends on, once each', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const loaded = localRefs(html).map(r => r.split('?')[0]);
  for (const f of ['session-store.js', 'storage.js', 'rides-sync.js', 'routes-sync.js', 'poi.js', 'prefs.js', 'prefs-sync.js', 'cloud-rest.js', 'route.js', 'app.js', 'alerts.js']) {
    assert.equal(loaded.filter(x => x === f).length, 1, `${f} should be loaded exactly once`);
  }
});
