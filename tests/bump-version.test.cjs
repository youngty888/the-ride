const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {bump, stamp, referencedFiles} = require('../scripts/bump-version.js');

const page = `<head>
<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="styles.css?v=20260909-sync1">
<script defer src="supabase-config.js?v=72624a2"></script>
<meta name="app-version" content="202608311533">
</head><body>
<script src="app.js?v=202609210804"></script>
<script src="poi.js"></script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</body>`;

test('every form of existing tag is re-stamped: numeric, dashed, hex and missing', () => {
  const out = bump(page, '202601010000');
  for (const f of ['styles.css', 'supabase-config.js', 'app.js', 'poi.js']) assert.ok(out.includes(`${f}?v=202601010000"`), f);
  assert.ok(!out.includes('sync1') && !out.includes('72624a2') && !out.includes('202609210804'));
});
test('absolute URLs are left alone', () => {
  const out = bump(page, '202601010000');
  assert.ok(out.includes('href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"'));
  assert.ok(out.includes('src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"'));
  assert.ok(out.includes('fonts.googleapis.com/css2?family=Inter&display=swap'));
});
test('the app-version meta tag follows the stamp', () => {
  assert.ok(bump(page, '202601010000').includes('<meta name="app-version" content="202601010000">'));
});
test('naming files re-stamps only those files', () => {
  const out = bump(page, '202601010000', ['app.js']);
  assert.ok(out.includes('app.js?v=202601010000"'));
  assert.ok(out.includes('styles.css?v=20260909-sync1"'));
  assert.ok(out.includes('supabase-config.js?v=72624a2"'));
  assert.ok(out.includes('content="202608311533"'), 'meta is left alone when only some files are named');
});
test('it can never mangle a tag (the old script once produced poi.=123)', () => {
  const out = bump(page, '202601010000');
  assert.ok(!/\.=\d/.test(out));
  assert.equal(referencedFiles(out).sort().join(), 'app.js,poi.js,styles.css,supabase-config.js');
});
test('running it twice gives the same page apart from the stamp', () => {
  assert.equal(bump(bump(page, '111111111111'), '222222222222'), bump(page, '222222222222'));
});
test('stamp is a 12-digit UTC timestamp', () => {
  assert.equal(stamp(new Date(Date.UTC(2026, 8, 21, 13, 5))), '202609211305');
});
test('the real pages only reference files that exist', () => {
  for (const name of ['index.html', 'auth.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    for (const ref of referencedFiles(html)) assert.ok(fs.existsSync(path.join(__dirname, '..', ref)), `${name}: ${ref}`);
  }
});
