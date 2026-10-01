// Fangs Warehouse: reading an eBay Seller Hub active listings report, and label barcodes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../warehouse/wh-import.js');
require('../warehouse/wh-labels.js');
const I = globalThis.WhImport, L = globalThis.WhLabels;

// Titles are real listings from the SW ODDS and ENDS AZ store page (public), prices as shown.
const report = [
  '"Seller Hub Reports","Active listings"',
  '',
  'Item number,Title,Custom label (SKU),Available quantity,Format,Currency,Start price,Current price,eBay category 1 name,Condition',
  '188814198230,"Harley Evolution Cam Cover Nose Cone Satin OEM 25266-93B, 1993-1998 Big Twin",,1,FIXED_PRICE,USD,42.00,42.00,Engines & Engine Parts,Used',
  '178454336035,Harley Davidson Shovelhead OEM Banana Brake Caliper,,1,FIXED_PRICE,USD,70.00,70.00,Brakes & Brake Parts,Used',
  '188997649367,HONDA LEFT TURN SIGNAL BLINKER LENS 33655-GS7-671 OEM SCOOTER AMBER,,2,FIXED_PRICE,USD,8.77,8.77,Lighting,New',
  '188217855180,Kutani partial Tea Set Jappanese Hand Painted Meiji Peroid,,1,FIXED_PRICE,USD,90.00,"$90.00",Japanese,Used',
  '188875487675,GENUINE AUDI MASTER POWER WINDOW SWITCH PANEL ASSY 4B0959851B NOS OEM NEW,,1,FIXED_PRICE,USD,100.00,100.00,Car & Truck Parts,New',
].join('\r\n');

test('finds the header row below eBay notes and maps columns', () => {
  const { rows, error } = I.ebayRows(report);
  assert.equal(error, null);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].ebay_item_id, '188814198230');
  assert.equal(rows[0].title, 'Harley Evolution Cam Cover Nose Cone Satin OEM 25266-93B, 1993-1998 Big Twin');
  assert.equal(rows[0].price, '42.00');
  assert.equal(rows[2].quantity, '2');
  assert.equal(rows[3].price, '90.00');
});

test('title hints: part numbers, engine family and category are suggestions only', () => {
  const [evo, shovel, honda] = I.ebayRows(report).rows;
  assert.equal(evo.part_number, '25266-93B');
  assert.equal(evo.hints.engine_family, 'evolution');
  assert.equal(evo.system_code, 'engine');
  assert.equal(evo.hints.years, '1993-1998');
  assert.equal(shovel.hints.engine_family, 'shovelhead');
  assert.equal(shovel.system_code, 'brakes');
  assert.equal(honda.part_number, '33655-GS7-671');
  assert.equal(honda.system_code, 'lighting');
  assert.equal(evo.hints.source, 'title_parse');
});

test('motorcycle parts are pre-selected; tea sets and car parts are not', () => {
  const inc = I.ebayRows(report).rows.map(r => r.include);
  assert.deepEqual(inc, [true, true, true, false, false]);
});

test('eBay photo links are read, upsized to 1600px, and non-eBay links dropped', () => {
  const csv = 'Item number,Title,PicURL\n1,Harley Evo cam cover,"https://i.ebayimg.com/images/g/a/s-l300.jpg|https://evil.example/b.jpg|https://i.ebayimg.com/images/g/c/s-l500.webp"';
  const [row] = I.ebayRows(csv).rows;
  assert.deepEqual(row.image_urls, ['https://i.ebayimg.com/images/g/a/s-l1600.jpg', 'https://i.ebayimg.com/images/g/c/s-l1600.webp']);
});

test('a file without item numbers is rejected with a clear message', () => {
  assert.match(I.ebayRows('Name,Price\nx,1').error, /Item number/);
});

test('Code 128 barcode: correct checksum and start/stop codes', () => {
  // "SIC-000123": start B (104) ... checksum = sum(value*pos) mod 103, then stop.
  const text = 'SIC-000123';
  let sum = 104; [...text].forEach((c, i) => { sum += (c.charCodeAt(0) - 32) * (i + 1); });
  const bars = L.code128B(text);
  assert.ok(bars.startsWith('211214'), 'start B');
  assert.ok(bars.endsWith('2331112'), 'stop');
  assert.equal(bars.length, 6 * (text.length + 2) + 7);
  assert.throws(() => L.code128B('é'), /ASCII/);
  assert.match(L.barcodeSvg(text), /^<svg[^>]+aria-label="SIC-000123"/);
  assert.equal(sum % 103, 37);
  assert.equal(bars.slice(-13, -7), '132113', 'checksum symbol 37 sits just before stop');
});
