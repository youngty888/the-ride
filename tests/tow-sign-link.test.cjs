// Tow page waiver link (?sign=): a failed load must not be reported as a bad
// link, and Try again must bring the form back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'tow', 'tow.js'), 'utf8');
const code = src.slice(src.indexOf('  // ---------- waiver from a link ----------'), src.indexOf('  function init() {'));

function page(rpc) {
  const intro = { kids: [], set textContent(t) { this.text = t; this.kids = []; }, get textContent() { return this.text; },
    append(...a) { this.kids.push(...a.filter(x => typeof x === 'object')); } };
  const form = { hidden: false, submits: 0, addEventListener() { this.submits++; } };
  const els = { mtSite: {}, mtSignView: {}, mtSignForm: form, mtSignIntro: intro };
  const ctx = { PHONE: '+15209995691', waiver: {}, rpc, msg() {}, loadWaiver() {}, setupWaiver: () => ({}), $: id => els[id],
    document: { createElement: tag => ({ tag, on: {}, addEventListener(t, f) { this.on[t] = f; } }) } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, intro, form };
}

test('no signal: says so, keeps call and text, and Try again shows the form', async () => {
  let fail = true;
  const { ctx, intro, form } = page(async () => { if (fail) throw new Error('down'); return { first_name: 'Sam', ref: 'T-1', signed: false }; });
  await ctx.initSign('x'.repeat(24));
  assert.match(intro.text, /could not load/);
  assert.doesNotMatch(intro.text, /not valid/);
  assert.equal(form.hidden, true);
  assert.deepEqual(intro.kids.map(k => k.href || k.textContent), ['tel:+15209995691', 'sms:+15209995691', 'Try again']);
  fail = false;
  await intro.kids[2].on.click();
  await new Promise(r => setImmediate(r));
  assert.match(intro.text, /Hi Sam/);
  assert.equal(form.hidden, false);
  assert.equal(form.submits, 1);
});

test('a bad or already signed link still hides the form', async () => {
  for (const [info, want] of [[null, /not valid/], [{ first_name: 'Sam', ref: 'T-1', signed: true }, /already signed/]]) {
    const { ctx, intro, form } = page(async () => info);
    await ctx.initSign('x'.repeat(24));
    assert.match(intro.text, want);
    assert.equal(form.hidden, true);
  }
});
