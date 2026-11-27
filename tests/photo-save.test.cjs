// Phone photos must be shrunk before they are stored, and a failed save must be reported.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function load({file, saves = true} = {}) {
  const saved = [], toasts = [], closed = [];
  const ctx = vm.createContext({console, Promise, Date, Math,
    document: {addEventListener() {}, getElementById: id => id === 'postPhoto' ? {files: file ? [file] : []} : {value: 'x'}},
    Storage: {getProfile: () => ({}), genId: () => 'p1', savePost: p => { saved.push(p); return saves; }}});
  vm.runInContext(src + '\nthis.A = App;', ctx);
  const A = ctx.A;
  A.toast = m => toasts.push(m); A.hideOverlay = id => closed.push(id); A.renderBlog = () => {};
  return {A, saved, toasts, closed};
}
const settle = () => new Promise(r => setImmediate(r));

test('a post stores the shrunk photo, once, even on a double tap', async () => {
  const {A, saved} = load({file: {}});
  const asked = [];
  A.shrinkPhoto = (f, max) => { asked.push(max); return Promise.resolve('data:image/jpeg;small'); };
  A.savePost(); A.savePost();
  await settle();
  assert.deepEqual(asked, [1280]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].photo, 'data:image/jpeg;small');
});

test('an unreadable photo posts nothing and says so', async () => {
  const {A, saved, toasts, closed} = load({file: {}});
  A.shrinkPhoto = () => Promise.reject(new Error('bad'));
  A.savePost();
  await settle();
  assert.equal(saved.length, 0);
  assert.equal(closed.length, 0);
  assert.match(toasts[0], /nothing was posted/);
});

test('full storage keeps the post form open and says so', () => {
  const {A, toasts, closed} = load({saves: false});
  A.savePost();
  assert.equal(closed.length, 0);
  assert.match(toasts[0], /out of storage/);
});
