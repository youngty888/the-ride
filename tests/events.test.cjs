const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Events = require('../events.js');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'events.json'), 'utf8'));

test('events.json: every event has id, title, dates and an https source', () => {
  for (const e of data.events) {
    assert.ok(e.id && e.title);
    assert.match(e.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(e.end, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.start <= e.end);
    assert.match(e.source, /^https:\/\//);
  }
});
test('active(): shows inside the window, hides before and after', () => {
  const l = [{id: 'a', title: 'A', start: '2026-11-18', end: '2026-11-21'}];
  assert.equal(Events.active(l, new Date(2026, 10, 17)).length, 0);
  assert.equal(Events.active(l, new Date(2026, 10, 18)).length, 1);
  assert.equal(Events.active(l, new Date(2026, 10, 21)).length, 1);
  assert.equal(Events.active(l, new Date(2026, 10, 22)).length, 0);
});
test('active(): ignores junk instead of throwing', () => {
  assert.deepEqual(Events.active(null), []);
  assert.deepEqual(Events.active([null, {}, {id: 1}]), []);
});
test('esc() and safeUrl() block markup and non-https links', () => {
  assert.equal(Events.esc('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  assert.equal(Events.safeUrl('javascript:alert(1)'), '');
  assert.equal(Events.safeUrl('https://a.com'), 'https://a.com');
});
