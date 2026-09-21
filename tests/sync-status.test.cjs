const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
  const box = {textContent: '', hidden: true};
  const ctx = vm.createContext({console, Object, document: {getElementById: id => id === 'syncStatus' ? box : null}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'cloud-rest.js'), 'utf8') + '\nthis.S = SyncStatus;', ctx);
  return {S: ctx.S, box};
}

test('the banner stays hidden while every sync is fine', () => {
  const {S, box} = load(); S.set('rides', ''); S.set('routes', '');
  assert.equal(box.hidden, true);
});
test('one source reporting shows the banner', () => {
  const {S, box} = load(); S.set('routes', 'Cloud unavailable (404). Saved routes will retry automatically.');
  assert.equal(box.hidden, false);
  assert.ok(box.textContent.includes('Saved routes'));
});
test('two sources share one banner instead of stacking', () => {
  const {S, box} = load(); S.set('rides', 'Ride history: saving…'); S.set('routes', 'Cloud unavailable (500).');
  assert.ok(box.textContent.includes('Ride history') && box.textContent.includes('Cloud unavailable'));
});
test('one source recovering clears only its own message', () => {
  const {S, box} = load(); S.set('rides', 'Ride history: saving…'); S.set('routes', 'Cloud unavailable (500).');
  S.set('rides', '');
  assert.equal(box.hidden, false);
  assert.ok(!box.textContent.includes('Ride history') && box.textContent.includes('Cloud unavailable'));
  S.set('routes', '');
  assert.equal(box.hidden, true);
});
test('a missing banner element never breaks a sync', () => {
  const ctx = vm.createContext({console, Object, document: {getElementById: () => null}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'cloud-rest.js'), 'utf8') + '\nthis.S = SyncStatus;', ctx);
  assert.doesNotThrow(() => ctx.S.set('rides', 'x'));
});
test('the page has the single banner and no leftovers', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('id="syncStatus"'));
  assert.ok(!html.includes('ridesCloudStatus') && !html.includes('routesCloudStatus'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(css.includes('#syncStatus[hidden]') && !css.includes('#ridesCloudStatus') && !css.includes('#routesCloudStatus'));
});
