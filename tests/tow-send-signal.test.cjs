// Tow page: when a booking or waiver gets no answer, say so in plain words with
// the number to call, and leave that on screen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'tow', 'tow.js'), 'utf8');
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));

function load() {
  const timers = [];
  const box = {};
  const ctx = { $: () => box, setTimeout: f => timers.push(f) };
  vm.createContext(ctx);
  vm.runInContext(between('  function msg(t)', '  // token: a signed-in') + between('  // A send with no answer', '  // ---------- signed-in RIDE rider')
    + '\nthis.msg = msg; this.sendError = sendError;', ctx);
  return { ctx, box, timers };
}

test('no answer: plain words and the number, and it does not disappear', () => {
  const { ctx, box, timers } = load();
  ctx.msg(ctx.sendError(new TypeError('Failed to fetch')));
  assert.match(box.textContent, /could not confirm.*520-999-5691 before sending again/);
  assert.equal(box.hidden, false);
  assert.equal(timers.length, 0);
});

test('an answer from the server is shown as written and still times out', () => {
  const { ctx, box, timers } = load();
  ctx.msg(ctx.sendError(Object.assign(new Error('Type your full name to sign'), { status: 400 })));
  assert.equal(box.textContent, 'Type your full name to sign');
  assert.equal(timers.length, 1);
});
