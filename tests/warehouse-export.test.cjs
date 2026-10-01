// Fangs Warehouse exports: Shopify CSV is Draft-only with stable handles, spreadsheets
// are safe to open in Excel, and the XLSX writer produces a valid workbook.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
require('../warehouse/wh-export.js');
const X = globalThis.WhExport;

const lookups = { systems: { engine: 'Engine' }, families: { evolution: 'Evolution (Evo)', shovelhead: 'Shovelhead' } };
const base = 'https://api.ride.siccycles.com';
const item = (over = {}) => ({
  id: 'i1', sku: 'SIC-000123', status: 'ready_to_publish', title: 'Harley Evo Rocker Box Set, Lower', description: 'Clean set.',
  brand: 'Harley-Davidson', oem_aftermarket: 'oem', oem_part_number: '17540-84', casting_numbers: ['17540-84'],
  system_code: 'engine', condition_grade: 'good', tested_status: 'not_applicable', quantity: 1, weight_oz: 40,
  asking_price: '149.99', fitment_status: 'verified_exact', bare_length_in: 9, bare_width_in: 5, bare_height_in: 3,
  local_pickup_only: false, created_by: 'u1', ...over,
});
const media = [
  { bucket: 'wh-marketplace', path: 'items/SIC-000123/overall_back/b.jpg', slot: 'overall_back', position: 2, hidden: false },
  { bucket: 'wh-marketplace', path: 'items/SIC-000123/overall_front/a.jpg', slot: 'overall_front', position: 1, hidden: false },
  { bucket: 'wh-originals', path: 'items/SIC-000123/sku_card/c.jpg', slot: 'sku_card', position: 0, hidden: false },
  { bucket: 'wh-marketplace', path: 'items/SIC-000123/defect/d.jpg', slot: 'defect', position: 3, hidden: true },
];
const fits = { i1: [{ make: 'Harley-Davidson', engine_family: 'evolution', platform: 'FLH Touring', start_year: 1984, end_year: 1999 }] };

test('Shopify CSV: current headers, Draft status, stable SKU handle, marketplace images only', () => {
  const out = X.shopifyCsv([item()], fits, { i1: media }, lookups, base);
  assert.equal(out.rows.length, 2, 'two visible marketplace images -> two rows');
  const [first, second] = out.rows;
  assert.equal(first['URL handle'], 'sic-000123');
  assert.equal(second['URL handle'], 'sic-000123');
  assert.equal(first.Status, 'draft');
  assert.equal(first.SKU, 'SIC-000123');
  assert.equal(first.Price, '149.99');
  assert.equal(first['Inventory quantity'], 1);
  assert.equal(first['Continue selling when out of stock'], 'FALSE');
  assert.equal(first['Weight value (grams)'], 1134);
  assert.equal(first['Product image URL'], `${base}/storage/v1/object/public/wh-marketplace/items/SIC-000123/overall_front/a.jpg`);
  assert.equal(second['Image position'], 2);
  assert.equal(second.Title, undefined, 'image rows carry only handle + image columns');
  assert.match(first.Description, /Evolution \(Evo\) FLH Touring 1984-1999/);
  assert.match(first.Tags, /sic-warehouse/);
  assert.ok(out.csv.startsWith('﻿Title,URL handle,Description'));
  assert.ok(!out.csv.includes('sku_card'), 'private original photos never exported');
});

test('Shopify CSV: title changes do not change the handle; unapproved items are refused', () => {
  const a = X.shopifyCsv([item({ title: 'New title' })], fits, { i1: media }, lookups, base).rows[0];
  assert.equal(a['URL handle'], 'sic-000123');
  const out = X.shopifyCsv([item({ status: 'fitment_review' }), item({ id: 'i2', sku: 'SIC-000124' })], fits, { i1: media }, lookups, base);
  assert.equal(out.rows.length, 0);
  assert.deepEqual(out.skipped.map(s => s.reason), ['status is fitment_review', 'no marketplace image']);
});

test('Shopify CSV uses eBay photo links for imported parts, after any new marketplace photos', () => {
  const ext = [{ bucket: 'external', path: 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg', slot: 'overall_front', position: 1, hidden: false }];
  const out = X.shopifyCsv([item()], fits, { i1: ext.concat(media) }, lookups, base);
  assert.equal(out.rows.length, 3);
  assert.equal(out.rows[2]['Product image URL'], 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg');
  const only = X.shopifyCsv([item()], fits, { i1: ext }, lookups, base);
  assert.equal(only.rows[0]['Product image URL'], 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg');
});

test('HTML in part text is escaped in the Shopify description', () => {
  const out = X.shopifyCsv([item({ description: '<script>alert(1)</script>' })], fits, { i1: media }, lookups, base);
  assert.ok(!out.rows[0].Description.includes('<script>'));
});

test('spreadsheet cells that look like formulas are neutralized', () => {
  assert.equal(X.safeText('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.equal(X.safeText('+1'), "'+1");
  assert.equal(X.safeText('@SUM'), "'@SUM");
  assert.equal(X.safeText(-5), '-5', 'real numbers stay numbers');
  const c = X.csv([{ a: '=1+1', b: 'x,"y"' }], ['a', 'b']);
  assert.ok(c.includes(`'=1+1,"x,""y"""`));
});

test('master table includes attribution names and hides financial columns unless allowed', () => {
  const t = X.itemTable([item({ updated_by: 'u2' })], { lookups, names: { u1: 'Jake', u2: 'Maria' }, fitmentsByItem: fits, mediaByItem: { i1: media }, baseUrl: base });
  assert.equal(t.rows[0]['Created by'], 'Jake');
  assert.equal(t.rows[0]['Last edited by'], 'Maria');
  assert.ok(!t.headers.includes('Cost'));
  assert.match(t.rows[0]['Image URLs'], /overall_front\/a\.jpg .*overall_back\/b\.jpg|overall_back\/b\.jpg .*overall_front\/a\.jpg/);
  const f = X.itemTable([item()], { lookups, financials: { i1: { cost: 20, consignor: 'Fang', min_approved_price: 120 } } });
  assert.equal(f.rows[0].Cost, 20);
  assert.equal(f.rows[0].Consignor, 'Fang');
});

test('XLSX writer produces a workbook Excel-compatible readers open', { skip: spawnSync('python3', ['-c', 'import openpyxl']).status !== 0 && 'openpyxl not installed' }, () => {
  const t = X.itemTable([item(), item({ id: 'i2', sku: 'SIC-000124', title: '=cmd|evil', quantity: 3 })], { lookups });
  const bytes = X.xlsx([{ name: 'Master', ...t }, { name: 'Drafts/Queue', headers: ['SKU'], rows: [] }]);
  const file = path.join(os.tmpdir(), `wh-${process.pid}.xlsx`);
  fs.writeFileSync(file, bytes);
  const py = `import openpyxl,sys\nwb=openpyxl.load_workbook(sys.argv[1])\nws=wb['Master']\nprint(wb.sheetnames)\nprint(ws['A2'].value, ws['A3'].value)\nprint([c.value for c in ws[3]][2])\nprint(ws.cell(row=3,column=[c.value for c in ws[1]].index('Qty')+1).value)`;
  const r = spawnSync('python3', ['-c', py, file], { encoding: 'utf8' });
  fs.unlinkSync(file);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], "['Master', 'Drafts Queue']");
  assert.equal(lines[1], 'SIC-000123 SIC-000124');
  assert.equal(lines[2], "'=cmd|evil");
  assert.equal(lines[3], '3');
});

test('sha256 and crc32 match known values', async () => {
  assert.equal(await X.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(X.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});
