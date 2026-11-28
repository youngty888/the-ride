// "Notify My Pack" must work without a saved pack and must never imply a message
// went out when it did not.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

async function notify(navigator, location = {lat: 32.1, lon: -110.9}) {
  const alerts = [];
  const ctx = vm.createContext({console, navigator, alert: m => alerts.push(m),
    window: {addEventListener() {}}, document: {addEventListener() {}},
    Storage: {getPacks: () => [], getProfile: () => ({})},
    MapModule: {currentLocation: location}});
  vm.runInContext(src + '\nthis.A = App;', ctx);
  ctx.A.notifyPack();
  await new Promise(r => setImmediate(r));
  return alerts;
}
const reject = name => () => Promise.reject(Object.assign(new Error(name), {name}));

test('opens the share screen even with no saved pack', async () => {
  let sent;
  const alerts = await notify({share: d => { sent = d; return Promise.resolve(); }});
  assert.match(sent.text, /I need help[\s\S]*maps\?q=32\.1,-110\.9/);
  assert.equal(alerts.length, 0);
});
test('no share screen, or it fails: says nothing was sent and shows the link', async () => {
  for (const nav of [{}, {share: reject('NotAllowedError')}]) {
    const alerts = await notify(nav);
    assert.match(alerts[0], /^Nothing was sent[\s\S]*maps\?q=32\.1,-110\.9/);
  }
});
test('rider cancels the share screen: no extra pop-up', async () => {
  assert.equal((await notify({share: reject('AbortError')})).length, 0);
});
test('no location: says nothing was sent', async () => {
  assert.match((await notify({}, null))[0], /Nothing was sent/);
});
