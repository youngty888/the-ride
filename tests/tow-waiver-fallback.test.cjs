// Tow page (tow/tow.js): when the waiver will not load, the page must still give
// a number to tap and a Try again that works.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'tow', 'tow.js'), 'utf8');
const fn = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));

test('a failed waiver shows call and text links, and Try again loads it', async () => {
  const el = tag => ({ tag, on: {}, addEventListener(t, f) { this.on[t] = f; } });
  const box = { kids: [], set textContent(t) { this.text = t; this.kids = []; }, get textContent() { return this.text; },
    append(...a) { this.kids.push(...a.filter(x => typeof x === 'object')); } };
  let fail = true;
  const ctx = {
    PHONE: '+15209995691', waiver: null,
    document: { createElement: el, querySelectorAll: () => [box] },
    rpc: async () => { if (fail) throw new Error('down'); return { body: 'WAIVER TEXT', version: '1' }; },
  };
  vm.createContext(ctx);
  vm.runInContext(fn('  // If the waiver will not load', '  // ---------- booking ----------'), ctx);
  await ctx.loadWaiver();
  assert.match(box.text, /could not load[\s\S]*520-999-5691/);
  assert.deepEqual(box.kids.map(k => k.href || k.textContent), ['tel:+15209995691', 'sms:+15209995691', 'Try again']);
  fail = false;
  await box.kids[2].on.click();
  assert.equal(box.text, 'WAIVER TEXT');
  assert.equal(box.kids.length, 0);
});
