/* SICC Syndicate weekly meeting form.
   Reads shop data (jobs, customers, bikes, part orders) with the staff
   sign-in and fills the job call board, parts on order and shop numbers.
   Read-only: this page never writes to the database. Notes typed on the
   page are kept in this browser only (localStorage), per meeting date,
   so a half-filled form survives a reload. Print gives a paper copy. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);

  const TOPICS = [
    ['calendar_week', 'Calendar review: this week', 'Events, appointments, pickups, shows.'],
    ['calendar_month', 'Calendar review: this month', 'Bigger dates coming up.'],
    ['property', 'Property', 'Shop space, lease, rent, building details.'],
    ['budgets', 'Budgets', 'What each area is allowed to spend.'],
    ['spending', 'Spending', 'What went out this week, anything over budget.'],
    ['goals', 'Goals', 'This week, this month, this year.'],
    ['production', 'Production', 'Bikes through the shop, bottlenecks, hours.'],
    ['sales', 'Sales', 'Shop sales, quotes out, follow-ups.'],
    ['organization', 'Organization', 'Who does what, systems, cleanup.'],
    ['constraints', 'Constraints', 'What is holding us back: people, parts, money, space, time.'],
    ['parts_orders', 'Parts and orders', 'Anything to order, returns, supplier problems.'],
    ['marketing', 'Marketing', 'Posts, events, ads, promotions.'],
    ['online_sales', 'Online sales', 'siccycles.com orders, listings, what is moving.'],
    ['consign_bikes', 'Consignment: bikes', 'Bikes in, priced, sold, paid out.'],
    ['consign_parts', 'Consignment: parts', 'Parts in, priced, sold, paid out.'],
  ];

  const money = n => (n == null || isNaN(n)) ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const iso = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
  const daysSince = s => { if (!s) return ''; const t = Date.parse(s + (s.length === 10 ? 'T12:00:00' : '')); return isNaN(t) ? '' : Math.max(0, Math.floor((Date.now() - t) / 86400000)); };
  const shortDate = s => s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const STATUS = { estimate: 'Estimate', in_progress: 'In work', complete: 'Done' };
  const PAID = { unpaid: 'No', partial: 'Partial', paid: 'Yes' };

  function el(tag, attrs = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'text') e.textContent = v; else if (k === 'cls') e.className = v; else e.setAttribute(k, v); }
    for (const k of [].concat(kids)) if (k != null) e.append(k);
    return e;
  }
  const td = (text, cls) => el('td', cls ? { cls, text: text ?? '' } : { text: text ?? '' });
  const inputCell = (name, type = 'text') => el('td', {}, el('input', { name, type, 'aria-label': name }));

  // ---------- notes kept in this browser ----------
  const keyFor = () => 'sicc-syndicate-' + ($('syDate').value || 'undated');
  function saveDraft() {
    const data = {};
    for (const f of $('syForm').elements) {
      if (!f.name || f.name === 'meeting_date') continue;
      data[f.name] = f.type === 'checkbox' ? f.checked : f.value;
    }
    try { localStorage.setItem(keyFor(), JSON.stringify(data)); } catch { /* private mode */ }
  }
  function loadDraft() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(keyFor()) || 'null'); } catch { data = null; }
    for (const f of $('syForm').elements) {
      if (!f.name || f.name === 'meeting_date') continue;
      const v = data ? data[f.name] : undefined;
      if (f.type === 'checkbox') f.checked = !!v;
      else if (v !== undefined) f.value = v;
      else if (f.name !== 'start_time' && f.name !== 'next_date') f.value = '';
    }
  }

  // ---------- static parts of the form ----------
  function buildTopics() {
    const box = $('syTopics');
    for (const [key, title, hint] of TOPICS) {
      box.append(el('section', { cls: 'sy-sec sy-topic' }, [
        el('h2', { text: title }),
        el('p', { cls: 'sy-note', text: hint }),
        el('textarea', { name: key + '_notes', rows: '3', 'aria-label': title + ' notes' }),
        el('div', { cls: 'sy-inline' }, [
          el('label', {}, ['Number / amount ', el('input', { name: key + '_amount' })]),
          el('label', {}, ['Follow-up owner ', el('input', { name: key + '_owner' })]),
          el('label', {}, ['Due ', el('input', { name: key + '_due', type: 'date' })]),
        ]),
      ]));
    }
  }
  function fillBlankRows(table) {
    const rows = Number(table.dataset.rows || 5), name = table.dataset.name;
    const tb = table.tBodies[0]; tb.replaceChildren();
    const cols = table.tHead.rows[0].cells.length;
    for (let r = 0; r < rows; r++) {
      const tr = el('tr');
      for (let c = 0; c < cols; c++) {
        const last = c === cols - 1 && name === 'action';
        tr.append(last ? el('td', { cls: 'sy-c' }, el('input', { type: 'checkbox', name: `${name}_${r}_${c}`, 'aria-label': 'done' }))
          : inputCell(`${name}_${r}_${c}`, /due|deadline/i.test(table.tHead.rows[0].cells[c].textContent) && c !== 1 ? 'date' : 'text'));
      }
      tb.append(tr);
    }
  }
  function blankRows(tbody, cols, n, prefix) {
    for (let r = 0; r < n; r++) {
      const tr = el('tr', { cls: 'sy-blank' });
      for (let c = 0; c < cols; c++) tr.append(inputCell(`${prefix}_extra_${r}_${c}`));
      tbody.append(tr);
    }
  }

  // ---------- shop data ----------
  const msg = (text, bad) => { const m = $('syMsg'); m.textContent = text; m.hidden = !text; m.classList.toggle('sh-msg-error', !!bad); };

  async function loadShop() {
    msg('');
    let ok = false;
    try { await ShApi.verify(); ok = (await ShApi.rpc('shop_has_staff_access', {})) === true; }
    catch (e) { if (e.status && e.status !== 401 && e.status !== 403) msg(`Could not reach the shop: ${e.message}`, true); }
    if (!ok) {
      renderBoard([], {}, {}); renderParts([], {}, {});
      $('syAsOf').textContent = 'Not signed in to the shop, so the job board and numbers are blank for hand entry. Sign in on the shop page, then tap Refresh data.';
      return;
    }
    try {
      const [jobs, customers, bikes, parts, audit, staff] = await Promise.all([
        ShApi.select('shop_jobs', 'select=id,invoice_number,estimate_number,customer_id,bike_id,status,payment_status,job_date,total_amount,work_description,notes,customer_notes&order=job_date.asc'),
        ShApi.select('shop_customers', 'select=id,name,phone'),
        ShApi.select('shop_bikes', 'select=id,vin,make,model,year,mileage'),
        ShApi.select('shop_part_orders', 'select=*&received=eq.false&order=date_ordered.asc').catch(() => null),
        ShApi.select('shop_audit_log', 'select=row_id,actor,changed_at,detail&table_name=eq.shop_jobs&action=eq.status&order=changed_at.asc').catch(() => []),
        ShApi.select('shop_staff', 'select=user_id,display_name').catch(() => []),
      ]);
      const staffName = Object.fromEntries((staff || []).map(s => [s.user_id, s.display_name]));
      const signedBy = {};
      for (const a of audit || []) if (a.detail && a.detail.to === 'complete') signedBy[a.row_id] = staffName[a.actor] || 'staff';
      const cById = Object.fromEntries(customers.map(c => [c.id, c]));
      const bById = Object.fromEntries(bikes.map(b => [b.id, b]));
      const jById = Object.fromEntries(jobs.map(j => [j.id, j]));
      const open = jobs.filter(j => !(j.status === 'complete' && j.payment_status === 'paid'));
      renderBoard(open, cById, bById, signedBy);
      renderParts(parts || [], jById, cById);
      renderStats(jobs, parts);
      $('syAsOf').textContent = `Filled from the shop ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` + (parts ? '' : ' Parts orders could not be read.');
    } catch (e) {
      msg(`Could not load shop data: ${e.message}`, true);
    }
  }

  function bikeText(b) {
    if (!b) return '';
    const name = [b.year, b.make, b.model].filter(Boolean).join(' ');
    const vin = b.vin ? `VIN …${String(b.vin).slice(-6)}` : '';
    const mi = b.mileage ? `${Number(b.mileage).toLocaleString()} mi` : '';
    return [name, vin, mi].filter(Boolean).join(' · ');
  }
  function jobNo(j) { return j.invoice_number ? `IV#${j.invoice_number}` : (j.estimate_number ? `EST#${j.estimate_number}` : ''); }

  function renderBoard(jobs, cById, bById, signedBy = {}) {
    const tb = $('syBoard').tBodies[0]; tb.replaceChildren();
    const rank = j => (j.status === 'complete' ? 0 : j.status === 'in_progress' ? 1 : 2);
    jobs.sort((a, b) => rank(a) - rank(b) || String(a.job_date).localeCompare(String(b.job_date)));
    jobs.forEach((j, i) => {
      const c = cById[j.customer_id] || {}; const unpaidDone = j.status === 'complete' && j.payment_status !== 'paid';
      const tr = el('tr', unpaidDone ? { cls: 'sy-flag' } : {});
      tr.append(
        el('td', {}, [el('b', { text: c.name || '' }), el('br'), c.phone || '']),
        td(bikeText(bById[j.bike_id])),
        el('td', {}, [jobNo(j), j.work_description ? el('div', { cls: 'sy-small', text: j.work_description }) : null]),
        el('td', {}, [STATUS[j.status] || j.status, signedBy[j.id] ? el('div', { cls: 'sy-small', text: `signed off: ${signedBy[j.id]}` }) : null]),
        td(money(j.total_amount), 'num'),
        td((unpaidDone ? 'NOT PAID' : PAID[j.payment_status]) || ''),
        td(String(daysSince(j.job_date)), 'num'),
        td([j.notes, j.customer_notes].filter(Boolean).join(' / '), 'sy-small'),
        inputCell(`board_${j.id}_next`),
      );
      tb.append(tr);
    });
    blankRows(tb, 9, jobs.length ? 3 : 8, 'board');
  }

  function renderParts(parts, jById, cById) {
    const tb = $('syParts').tBodies[0]; tb.replaceChildren();
    for (const p of parts) {
      const j = jById[p.job_id]; const c = j ? cById[j.customer_id] : null;
      tb.append(el('tr', {}, [
        td(p.part_description),
        td([p.supplier_name, p.order_number && `#${p.order_number}`].filter(Boolean).join(' ')),
        td([j && jobNo(j), c && c.name].filter(Boolean).join(' · ')),
        td(shortDate(p.date_ordered)),
        td(String(daysSince(p.date_ordered)), 'num'),
        inputCell(`part_${p.id}_eta`, 'date'),
      ]));
    }
    blankRows(tb, 6, parts.length ? 3 : 6, 'part');
  }

  function renderStats(jobs, parts) {
    const now = new Date(); const weekAgo = iso(new Date(Date.now() - 7 * 86400000)); const monthStart = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    const sum = list => list.reduce((s, j) => s + Number(j.total_amount || 0), 0);
    const invoiced = jobs.filter(j => j.status !== 'estimate');
    const unpaid = jobs.filter(j => j.status === 'complete' && j.payment_status !== 'paid');
    $('stInWork').textContent = jobs.filter(j => j.status === 'in_progress').length;
    $('stEstimates').textContent = jobs.filter(j => j.status === 'estimate').length;
    $('stUnpaidCount').textContent = unpaid.length;
    $('stUnpaid').textContent = money(sum(unpaid));
    $('stWeek').textContent = money(sum(invoiced.filter(j => j.job_date >= weekAgo)));
    $('stMonth').textContent = money(sum(invoiced.filter(j => j.job_date >= monthStart)));
    $('stParts').textContent = parts ? parts.length : '—';
  }

  // ---------- start ----------
  function nextSunday(from) { const d = new Date(from); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return d; }
  function init() {
    buildTopics();
    document.querySelectorAll('table.sy-fill').forEach(fillBlankRows);
    const meet = nextSunday(new Date());
    $('syDate').value = iso(meet);
    $('syNext').value = iso(new Date(meet.getTime() + 7 * 86400000));
    $('syPrinted').textContent = new Date().toLocaleDateString('en-US');
    loadDraft();
    $('syForm').addEventListener('input', saveDraft);
    $('syForm').addEventListener('change', e => { if (e.target.id === 'syDate') loadDraft(); else saveDraft(); });
    $('syPrint').addEventListener('click', () => { $('syPrinted').textContent = new Date().toLocaleDateString('en-US'); root.print(); });
    $('syRefresh').addEventListener('click', () => loadShop().then(loadDraft));
    $('syClear').addEventListener('click', () => {
      if (!root.confirm('Clear the notes typed for this meeting date on this device?')) return;
      try { localStorage.removeItem(keyFor()); } catch { /* ignore */ }
      loadDraft();
    });
    loadShop().then(loadDraft);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
