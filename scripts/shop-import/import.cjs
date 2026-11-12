#!/usr/bin/env node
/* Import SICSYSTEMS invoices into the shop database.

   Step 1 (private file, never commit it):
     python3 scripts/shop-import/sicsystems_to_json.py SICSYSTEMS.xlsx sicsystems.json
   Step 2 (dry run: shows every invoice, the new totals, and anything that does
   not match the sheet; writes nothing):
     node scripts/shop-import/import.cjs sicsystems.json [--fixes fixes.json]
   (fixes.json = the owner's decisions on flagged invoices; see buildPlan.
   It names customers, so keep it private like the data file.)
   Step 3 (write, as a shop staff account):
     SHOP_EMAIL=you@example.com SHOP_PASSWORD=... \
       node scripts/shop-import/import.cjs sicsystems.json --apply [--settings] [--url https://api.ride.siccycles.com]

   Re-running is safe: every invoice, customer and bike gets a fixed id derived
   from the sheet, so a second run updates the same records instead of adding
   copies. Imported invoices keep their sheet numbers (#1035 stays #1035) and
   new estimates continue after the highest one.

   How a sheet row becomes lines: the "Labor Hrs"/"Labor $" part becomes a labor
   line; the sheet's "Cost" column is what the customer paid for parts (it is
   the taxed amount), so it becomes a part line's price. Our real parts cost
   comes from Jobs_Log "Parts Cost $" and is spread over the part lines
   (internal only). Tax: 8.7% on parts from the sheet's Settings tab, except
   invoices where the sheet charged no tax, which are imported as "No tax" so
   the total matches what the customer was charged. */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ShCalc = require(path.join(__dirname, '..', '..', 'shop', 'sh-calc.js'));

const hid = (prefix, s) => `sicsys-${prefix}-${crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16)}`;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const digits = s => String(s || '').replace(/\D/g, '');
const cents = n => Math.round(Number(n || 0) * 100);
const fmt = c => ShCalc.money(BigInt(c));
const dec2 = n => { const c = cents(n); return (c / 100).toFixed(2); };
const isNum = v => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));
const STATUS = s => { const v = norm(s); return /complete|paid/.test(v) ? 'complete' : /approved|i w|progress/.test(v) ? 'in_progress' : 'estimate'; };

function tabNumber(inv) {
  const m = /(\d{4})/.exec(inv.tab);
  const t = m ? Number(m[1]) : null;
  return t && t >= 1000 && t < 2000 ? t : inv.number;
}

// Sheet row -> 0..2 shop lines.
function rowToLines(row, warnings, label, addTotalOnly = false) {
  const out = [];
  const desc = row.description || '(no description)';
  const hrs = Number(row.labor_hours || 0); const labor = Number(row.labor_amount || 0); const price = Number(row.parts_price || 0);
  const declined = /declin/i.test(row.order_log) || /declin/i.test(row.parts_ordered);
  if (labor > 0) {
    let qty = '1', rate = dec2(labor), d = desc;
    if (hrs > 0 && Math.round(hrs * 100) === hrs * 100) {
      const r = (Math.round((labor / hrs) * 100) / 100).toFixed(2);
      if (cents(Number(r) * hrs) === cents(labor)) { qty = String(hrs); rate = r; }
      else d = `${desc} (${hrs} hrs)`;
    }
    out.push({ kind: 'labor', description: d, quantity: qty, unit_price: rate });
  }
  if (price > 0) out.push({ kind: 'part', description: labor > 0 ? `${desc} (parts)` : desc, quantity: '1', unit_price: dec2(price), unit_cost: '' });
  if (!out.length) {
    if (!declined && row.line_total && addTotalOnly && row.line_total > 0) {
      // Owner said to bill these rows: amount only in "Line Total $" becomes a labor line.
      out.push({ kind: 'labor', description: desc, quantity: '1', unit_price: dec2(row.line_total) });
      return out;
    }
    if (!declined && row.line_total) {
      // A money row with nothing in Labor $ or Cost (e.g. "payment @ pickup -100"):
      // not work, so it is not put on the estimate. It is reported instead.
      warnings.push(`${label}: row ${row.row} "${desc}" (${fmt(cents(row.line_total))}) has no labor or parts amount; left off the estimate and noted.`);
      row.skippedNote = `Sheet row not imported: "${desc}" ${fmt(cents(row.line_total))}`;
      return out;
    }
    out.push({ kind: 'labor', description: declined ? `${desc} (declined)` : `${desc} (no charge)`, quantity: '1', unit_price: '0.00' });
  }
  if (row.line_total !== null && row.line_total !== undefined && cents(row.line_total) !== cents(labor + price) && !(row.line_total === 0 && declined) && !row.skippedNote) {
    warnings.push(`${label}: row ${row.row} "${desc}" line total on sheet ${fmt(cents(row.line_total))} but labor + parts = ${fmt(cents(labor + price))}`);
  }
  return out;
}

function spreadCost(items, totalCost) {
  const parts = items.filter(i => i.kind === 'part');
  const totalPrice = parts.reduce((s, i) => s + cents(i.unit_price), 0);
  if (!parts.length || !totalPrice) return;
  let left = cents(totalCost);
  parts.forEach((p, i) => {
    const c = i === parts.length - 1 ? left : Math.round(cents(totalCost) * cents(p.unit_price) / totalPrice);
    left -= c; p.unit_cost = (c / 100).toFixed(2);
  });
}

const plan_name = (customers, key) => customers.get(key)?.name || key;

// fixes (owner decisions, kept in a private file, see --fixes):
//   sameCustomer: [["Name to keep", "Other spelling"], ...]  merge into one customer
//   addRows:      [1004, ...]  bill rows whose amount is only in "Line Total $"
//   chargeTax:    [1016, ...]  charge tax on parts even though the sheet did not
//   reviewed:     {"1026": "why the new total is right", ...}  checked by the owner
function buildPlan(data, fixes = {}) {
  const alias = new Map((fixes.sameCustomer || []).flatMap(([keep, ...others]) => others.map(o => [norm(o), keep])));
  const addRows = new Set((fixes.addRows || []).map(Number)); const chargeTax = new Set((fixes.chargeTax || []).map(Number));
  const reviewed = Object.fromEntries(Object.entries(fixes.reviewed || {}).map(([k, v]) => [Number(k), v]));
  const warnings = []; const skipped = [];
  const rate = isNum(data.settings?.['Sales Tax Rate']) ? (Number(data.settings['Sales Tax Rate']) * 100).toFixed(3).replace(/\.?0+$/, '') : null;
  if (!rate) warnings.push('Settings tab has no Sales Tax Rate; invoices will import with no tax rate.');

  // One tab per invoice number. If two tabs share a number keep the completed one.
  const byNum = new Map();
  for (const inv of data.invoices) {
    const n = tabNumber(inv);
    if (n !== inv.number) warnings.push(`Tab "${inv.tab}": header says #${inv.number}; using #${n} from the tab name.`);
    const prev = byNum.get(n);
    if (!prev) { byNum.set(n, inv); continue; }
    const keep = STATUS(inv.status) === 'complete' && STATUS(prev.status) !== 'complete' ? inv : prev;
    const drop = keep === inv ? prev : inv;
    byNum.set(n, keep); skipped.push(`Tab "${drop.tab}" not imported: same invoice #${n} as tab "${keep.tab}" (kept that one).`);
  }

  const customers = new Map(); const bikes = new Map(); const jobs = [];
  for (const [num, inv] of [...byNum.entries()].sort((a, b) => a[0] - b[0])) {
    const label = `#${num} (${inv.tab})`;
    const log = data.jobs_log?.[num] || data.jobs_log?.[String(num)] || {};
    const c = inv.customer; const rawName = c.name || log.Customer || `Unknown (#${num})`;
    const cname = alias.get(norm(rawName)) || rawName;
    if (cname !== rawName) warnings.push(`${label}: customer "${rawName}" merged into "${cname}" (owner decision).`);
    let ckey = norm(cname);
    const existing = customers.get(ckey);
    if (existing && existing.phone && c.phone && digits(existing.phone) !== digits(c.phone)) {
      ckey = `${ckey}|${digits(c.phone)}`;
      warnings.push(`${label}: "${cname}" has a different phone than an earlier "${existing.name}"; kept as a separate customer.`);
    }
    const cust = customers.get(ckey) || { id: hid('c', ckey), name: cname, phone: '', email: '', address: '', invoices: [] };
    for (const k of ['phone', 'email', 'address']) if (!cust[k] && c[k]) cust[k] = c[k];
    cust.invoices.push(num); customers.set(ckey, cust);

    const b = inv.bike; let bike = null;
    const vin = String(b.vin || '').replace(/\s+/g, '').toUpperCase();
    const goodVin = vin.length >= 6 && !/^N\/?A$/.test(vin) ? vin : '';
    if (goodVin || b.make || b.model || b.year) {
      const bkey = `${ckey}|${goodVin || norm([b.year, b.make, b.model].join(' '))}`;
      bike = bikes.get(bkey) || { id: hid('b', bkey), customerKey: ckey, vin: goodVin, make: b.make, model: b.model, year: '', mileage: '', photos: undefined };
      if (/^\d{4}$/.test(String(b.year).trim())) bike.year = String(b.year).trim();
      else if (b.year) warnings.push(`${label}: year "${b.year}" is not a 4-digit year; left blank.`);
      if (/^\d{1,9}$/.test(String(b.mileage))) bike.mileage = String(b.mileage);
      if (!bike.make && b.make) bike.make = b.make; if (!bike.model && b.model) bike.model = b.model;
      bikes.set(bkey, bike);
    }

    const items = inv.lines.flatMap(r => rowToLines(r, warnings, label, addRows.has(num)));
    const costNote = [];
    if (isNum(log['Parts Cost $'])) spreadCost(items, Number(log['Parts Cost $']));
    else if (log['Parts Cost $']) costNote.push(`Our parts cost on Jobs_Log: "${log['Parts Cost $']}"`);

    const st = inv.sheet_totals || {};
    const sheetTax = Number(st.tax || 0); const sheetParts = items.filter(i => i.kind === 'part').reduce((s, i) => s + cents(i.unit_price), 0);
    const applies = rate && (sheetTax > 0 || sheetParts === 0 || chargeTax.has(num)) ? 'parts' : 'none';
    if (rate && sheetParts > 0 && sheetTax === 0 && chargeTax.has(num)) warnings.push(`${label}: tax added on ${fmt(sheetParts)} of parts (owner decision; the sheet charged none).`);
    else if (rate && sheetParts > 0 && sheetTax === 0) warnings.push(`${label}: sheet charged no tax on ${fmt(sheetParts)} of parts; imported as "No tax" to match what was charged.`);
    const calc = ShCalc.calculate(items, { rate: applies === 'none' ? '' : rate, appliesTo: applies });
    if (calc.errors.length) warnings.push(`${label}: ${calc.errors.join('; ')}`);

    // Compare with the sheet.
    const issues = [];
    if (isNum(st.labor) && cents(st.labor) !== Number(calc.laborCents)) issues.push(`labor subtotal on sheet ${fmt(cents(st.labor))}, lines add up to ${fmt(Number(calc.laborCents))}`);
    if (isNum(st.parts) && cents(st.parts) !== Number(calc.partsCents)) issues.push(`parts subtotal on sheet ${fmt(cents(st.parts))}, lines add up to ${fmt(Number(calc.partsCents))}`);
    if (isNum(st.subtotal) && isNum(st.labor) && isNum(st.parts) && cents(st.subtotal) !== cents(st.labor) + cents(st.parts)) issues.push(`sheet "Total" ${fmt(cents(st.subtotal))} is not labor + parts (${fmt(cents(st.labor) + cents(st.parts))}) — formula error on the sheet`);
    if (isNum(st.grand) && cents(st.grand) !== Number(calc.totalCents)) issues.push(`grand total on sheet ${fmt(cents(st.grand))}, new system ${fmt(Number(calc.totalCents))}`);
    if (isNum(log['Total $']) && cents(log['Total $']) !== Number(calc.totalCents)) issues.push(`Jobs_Log total ${fmt(cents(log['Total $']))}, new system ${fmt(Number(calc.totalCents))}`);

    const pay = [inv.payment, inv.payment_note].filter(Boolean).join(' – ');
    const notes = [`Imported from SICSYSTEMS tab "${inv.tab}".`, pay && `Payment: ${pay}.`, inv.authorized_by && `Authorized by ${inv.authorized_by}.`,
      log.Notes && `Jobs_Log note: ${log.Notes}`, ...costNote, ...inv.lines.filter(r => r.skippedNote).map(r => r.skippedNote),
      cname !== rawName && `Customer name on the sheet: "${rawName}".`,
      addRows.has(num) && 'Rows with an amount only in "Line Total $" were added as labor (owner decision).',
      chargeTax.has(num) && sheetTax === 0 && sheetParts > 0 && `Tax on parts added (owner decision); the sheet charged ${fmt(cents(st.grand))} with no tax.`,
      issues.length && `Sheet check: ${issues.join('; ')}.`, reviewed[num] && `Reviewed: ${reviewed[num]}`].filter(Boolean).join('\n');

    jobs.push({ number: num, label, customerKey: ckey, bike, items, calc, issues, reviewed: reviewed[num] || '', sheet: st, log,
      job: { status: STATUS(inv.status), job_date: inv.date || (typeof log.Date === 'string' ? log.Date.slice(0, 10) : '') || '',
        invoice_number: String(num), estimate_number: String(num), notes, work_description: '', customer_notes: '',
        tax_rate: applies === 'none' ? '' : rate, tax_applies_to: applies },
      id: hid('j', num) });
    if (!jobs[jobs.length - 1].job.job_date) warnings.push(`${label}: no date on the tab or Jobs_Log; will use the import date.`);
  }

  const vins = new Map();
  for (const j of jobs) if (j.bike?.vin) {
    const other = vins.get(j.bike.vin);
    if (other && other.key !== j.customerKey) warnings.push(`Same VIN ${j.bike.vin} on "${plan_name(customers, other.key)}" (#${other.num}) and "${plan_name(customers, j.customerKey)}" (#${j.number}) — probably the same person; kept separate.`);
    else vins.set(j.bike.vin, { key: j.customerKey, num: j.number });
  }

  // Names that might be the same person (not merged automatically).
  const names = [...customers.values()];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = norm(names[i].name), b = norm(names[j].name);
    const [af, ...ar] = a.split(' '), [bf, ...br] = b.split(' ');
    const lastClose = !ar.length || !br.length || ar[ar.length - 1].slice(0, 4) === br[br.length - 1].slice(0, 4);
    if (af && af === bf && a !== b && lastClose) warnings.push(`Possible same customer: "${names[i].name}" (#${names[i].invoices.join(', #')}) and "${names[j].name}" (#${names[j].invoices.join(', #')}) — kept separate.`);
  }

  const settings = {
    business_name: data.settings?.['Shop Name'] || 'SIC Cycles', phone: data.settings?.Phone || '', email: data.settings?.Email || '',
    default_tax_rate: rate || '', default_tax_applies_to: /parts/i.test(String(data.settings?.['Sales Tax Rate'] ?? '')) ? 'parts' : 'parts',
    estimate_terms: (data.policies || []).map(p => `• ${p}`).join('\n'),
  };
  return { settings, customers, jobs, warnings, skipped };
}

function rpcArgs(plan, j) {
  const c = plan.customers.get(j.customerKey);
  return {
    p_job_id: j.id, p_customer_id: c.id,
    p_customer: { name: c.name, phone: c.phone, email: c.email, address: c.address },
    p_bike_id: j.bike ? j.bike.id : null,
    p_bike: j.bike ? { vin: j.bike.vin, make: j.bike.make, model: j.bike.model, year: j.bike.year, mileage: j.bike.mileage } : null,
    p_job: j.job, p_items: j.items,
  };
}

function report(plan) {
  const L = [];
  const tot = plan.jobs.reduce((s, j) => s + Number(j.calc.totalCents), 0);
  L.push(`${plan.jobs.length} invoices, ${plan.customers.size} customers, total ${fmt(tot)}.`);
  L.push(`Shop settings from the sheet: tax ${plan.settings.default_tax_rate || 'not set'}% on parts, phone ${plan.settings.phone}, email ${plan.settings.email}.`);
  L.push('');
  for (const j of plan.jobs) {
    const flag = !j.issues.length ? 'OK   ' : j.reviewed ? 'FIXED' : 'CHECK';
    L.push(`${flag} #${j.number} ${plan.customers.get(j.customerKey).name} — ${j.job.status} — ${j.items.length} lines — parts ${fmt(Number(j.calc.partsCents))} labor ${fmt(Number(j.calc.laborCents))} tax ${fmt(Number(j.calc.taxCents))} = ${fmt(Number(j.calc.totalCents))}`);
    for (const i of j.issues) L.push(`        ${i}`);
    if (j.reviewed) L.push(`        reviewed: ${j.reviewed}`);
  }
  if (plan.skipped.length) { L.push('', 'Skipped:'); plan.skipped.forEach(s => L.push(`  ${s}`)); }
  if (plan.warnings.length) { L.push('', 'Notes:'); plan.warnings.forEach(s => L.push(`  ${s}`)); }
  return L.join('\n');
}

async function apply(plan, { url, email, password, anonKey, withSettings, log = console.log }) {
  const call = async (p, body, token) => {
    const res = await fetch(url + p, { method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error((data && (data.message || data.error_description || data.msg)) || `HTTP ${res.status}`);
    return data;
  };
  const s = await call('/auth/v1/token?grant_type=password', { email, password });
  if (await call('/rest/v1/rpc/shop_has_staff_access', {}, s.access_token) !== true) throw new Error(`${email} is not on the shop staff list.`);
  if (withSettings) { await call('/rest/v1/rpc/shop_update_settings', { p_settings: plan.settings }, s.access_token); log('Settings saved.'); }
  const results = [];
  for (const j of plan.jobs) {
    try {
      const r = await call('/rest/v1/rpc/shop_save_estimate', rpcArgs(plan, j), s.access_token);
      const ok = Number(r.estimate_number) === j.number && ShCalc.centsOf(r.total_amount) === j.calc.totalCents;
      results.push({ number: j.number, ok, saved: r }); log(`${ok ? 'saved ' : 'CHECK '} #${r.estimate_number} total ${r.total_amount}`);
    } catch (e) {
      // Already imported under this number by an earlier run? Then it is an update of the same id; otherwise report.
      results.push({ number: j.number, ok: false, error: e.message }); log(`FAILED #${j.number}: ${e.message}`);
    }
  }
  return results;
}

module.exports = { buildPlan, rpcArgs, report, apply, rowToLines };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--fixes' && args[i - 1] !== '--url');
    if (!file) { console.error('usage: import.cjs sicsystems.json [--fixes fixes.json] [--apply] [--settings] [--url URL]'); process.exit(2); }
    const fixesFile = args.includes('--fixes') ? args[args.indexOf('--fixes') + 1] : null;
    const fixes = fixesFile ? JSON.parse(fs.readFileSync(fixesFile, 'utf8')) : {};
    const plan = buildPlan(JSON.parse(fs.readFileSync(file, 'utf8')), fixes);
    console.log(report(plan));
    if (!args.includes('--apply')) { console.log('\nDry run only. Add --apply to write.'); return; }
    const cfgText = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase-config.js'), 'utf8');
    const url = (args[args.indexOf('--url') + 1] && args.includes('--url')) ? args[args.indexOf('--url') + 1] : /url:\s*'([^']+)'/.exec(cfgText)[1];
    const anonKey = /anonKey:\s*'([^']+)'/.exec(cfgText)[1];
    const { SHOP_EMAIL: email, SHOP_PASSWORD: password } = process.env;
    if (!email || !password) { console.error('Set SHOP_EMAIL and SHOP_PASSWORD (a shop staff account).'); process.exit(2); }
    const res = await apply(plan, { url, email, password, anonKey, withSettings: args.includes('--settings') });
    const bad = res.filter(r => !r.ok);
    console.log(`\n${res.length - bad.length} of ${res.length} imported and matched.`);
    process.exit(bad.length ? 1 : 0);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
