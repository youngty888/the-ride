const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

test('RIDE and shop sign-in pages load the show-password button', () => {
  assert.match(fs.readFileSync(path.join(root, 'auth.html'), 'utf8'), /show-password\.js/);
  assert.match(fs.readFileSync(path.join(root, 'shop/index.html'), 'utf8'), /\.\.\/show-password\.js/);
});

test('show-password.js toggles a password box between hidden and visible', () => {
  const src = fs.readFileSync(path.join(root, 'show-password.js'), 'utf8');
  const input = { type: 'password', dataset: {}, closest: () => null, insertAdjacentElement(_, b) { this.btn = b; } };
  const handlers = {};
  const btn = { style: {}, setAttribute() {}, addEventListener(e, f) { handlers[e] = f; } };
  const document = {
    readyState: 'complete',
    createElement: () => btn,
    querySelectorAll: () => [input],
    addEventListener() {},
  };
  new Function('document', src)(document);
  assert.strictEqual(btn.textContent, 'Show password');
  handlers.click();
  assert.strictEqual(input.type, 'text');
  assert.strictEqual(btn.textContent, 'Hide password');
  handlers.click();
  assert.strictEqual(input.type, 'password');
});
