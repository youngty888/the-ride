// The Emergency screen must not say the location was shared unless it was.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

async function share(navigator) {
  const els = {}, alerts = [];
  const ctx = vm.createContext({console, navigator, alert: m => alerts.push(m),
    window: {addEventListener() {}},
    document: {addEventListener() {}, getElementById: id => els[id] || (els[id] = {style: {}, textContent: ''})},
    MapModule: {currentLocation: {lat: 32.1, lon: -110.9}}});
  vm.runInContext(src + '\nthis.A = App;', ctx);
  ctx.A.shareLocation();
  await new Promise(r => setImmediate(r));
  return {status: els.locationStatus.textContent, alerts, href: els.locationLink.href};
}
const reject = name => () => Promise.reject(Object.assign(new Error(name), {name}));

test('share sheet completed: asks the rider to check it was sent', async () => {
  const r = await share({share: () => Promise.resolve()});
  assert.match(r.status, /^Passed to your share app/);
  assert.equal(r.href, 'https://www.google.com/maps?q=32.1,-110.9');
});
test('share sheet cancelled: says not shared', async () => {
  const r = await share({share: reject('AbortError')});
  assert.match(r.status, /^Not shared/);
  assert.equal(r.alerts.length, 0);
});
test('share fails: falls back to copying the link', async () => {
  const r = await share({share: reject('NotAllowedError'), clipboard: {writeText: () => Promise.resolve()}});
  assert.match(r.status, /copied, not sent yet/);
});
test('copy fails or is unavailable: says nothing was sent', async () => {
  for (const nav of [{}, {clipboard: {writeText: reject('NotAllowedError')}}]) {
    const r = await share(nav);
    assert.match(r.status, /^Not shared/);
    assert.match(r.alerts[0], /Nothing was sent[\s\S]*maps\?q=32\.1,-110\.9/);
  }
});
test('while the share sheet is open it does not claim anything was shared', async () => {
  const r = await share({share: () => new Promise(() => {})});
  assert.equal(r.status, 'Your location (not shared yet):');
});
