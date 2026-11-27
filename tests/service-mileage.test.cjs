// "12,500" typed into a service record used to save as 12.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function add(entered) {
  const saved = [], alerts = [];
  const answers = ['Oil Change', entered, ''];
  const ctx = vm.createContext({console, Date, Math,
    document: {addEventListener() {}},
    prompt: () => answers.shift(), alert: m => alerts.push(m),
    Storage: {genId: () => 's1', getBike: () => ({id: 'b1'}), saveBike: b => saved.push(b)}});
  vm.runInContext(src + '\nthis.A = App;', ctx);
  ctx.A.showBikeDetail = () => {};
  ctx.A.addServiceRecord('b1');
  return {saved, alerts};
}

test('commas and "mi" are read as the full mileage', () => {
  for (const [text, miles] of [['12,500', 12500], ['12500', 12500], [' 12500 mi ', 12500], ['1,234,567', 1234567], ['999.6', 1000], ['0', 0]]) {
    assert.equal(add(text).saved[0].serviceRecords[0].miles, miles, text);
  }
});

test('anything unclear saves nothing and says so', () => {
  for (const text of ['abc', '12k', '12,50', '-5', '12 500']) {
    const {saved, alerts} = add(text);
    assert.equal(saved.length, 0, text);
    assert.match(alerts[0], /Nothing was saved/);
  }
});
