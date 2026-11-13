/* Fangs Warehouse — staff app. Everything is built with DOM nodes and textContent (never
   innerHTML with data), and every permission is re-checked by the database. */
(function () {
  'use strict';
  const A = window.WhApi, X = window.WhExport, L = window.WhLabels, IM = window.WhImport;
  const $app = document.getElementById('app');
  const $who = document.getElementById('who');
  const $flash = document.getElementById('flash');
  const $dialog = document.getElementById('dialog');

  const S = {
    me: null, names: {}, staff: [], roles: [], systems: [], families: [], catMeas: [],
    items: [], media: {}, fitments: {}, tab: 'mine', queue: 'fitment_review',
    filter: { q: '', status: '', worker: '' }, sort: { key: 'updated_at', dir: -1 },
    ed: null, uploads: [], lastActivity: Date.now(), importRows: null,
  };

  const STATUS = {
    draft: 'Draft', research_draft: 'Research draft', fitment_review: 'Fitment review', needs_info: 'Needs info',
    listing_review: 'Listing review', ready_to_publish: 'Ready to publish', published: 'Published', reserved: 'Reserved',
    sold: 'Sold', shipped: 'Shipped', installed: 'Installed', on_hold: 'On hold', archived: 'Archived',
  };
  const OPT = {
    oem_aftermarket: [['oem', 'OEM'], ['aftermarket', 'Aftermarket'], ['unknown', 'Unknown']],
    condition_grade: Object.entries(X.CONDITION),
    tested_status: Object.entries(X.TESTED),
    fitment_status: Object.entries(X.FITMENT_STATUS),
    fitment_evidence_level: [['part_number_match', 'Part number match'], ['catalog_reference', 'Catalog / parts book reference'],
      ['physical_test_fit', 'Physical test fit'], ['measurement_match', 'Measurement match'], ['seller_claim', 'Seller / previous owner claim'],
      ['ai_suggestion', 'AI suggestion (not enough to publish)']],
    weight_source: [['scale', 'Scale'], ['estimated', 'Estimated'], ['photo_estimate', 'Photo estimate']],
    shipping_class: [['small_parcel', 'Small parcel'], ['medium_parcel', 'Medium parcel'], ['large_parcel', 'Large parcel'],
      ['oversize', 'Oversize'], ['freight', 'Freight'], ['local_pickup', 'Local pickup']],
    method: [['caliper', 'Caliper'], ['tape', 'Tape'], ['scale', 'Scale'], ['count', 'Count'], ['photo_estimate', 'Photo estimate']],
  };
  const FIELD = {
    title: { label: 'Title', wide: true, hint: 'Make, model/years, part name, part number' },
    system_code: { label: 'System / category', type: 'select', opts: () => S.systems.map(s => [s.code, s.label]) },
    brand: { label: 'Brand' }, oem_aftermarket: { label: 'OEM or aftermarket', type: 'select' },
    oem_part_number: { label: 'OEM part number' }, casting_numbers: { label: 'Casting / stamped numbers', type: 'list', hint: 'Separate with commas' },
    description: { label: 'Search-friendly description', type: 'textarea', wide: true },
    color: { label: 'Color / finish' }, material: { label: 'Material' }, quantity: { label: 'Quantity', type: 'int' },
    fitment_status: { label: 'Fitment status', type: 'select' }, fitment_evidence_level: { label: 'Evidence level', type: 'select' },
    fitment_evidence_source: { label: 'Evidence source', wide: true, hint: 'e.g. HD parts catalog 99456-84, test-fit on 1995 FLHTC' },
    condition_grade: { label: 'Condition grade', type: 'select' }, tested_status: { label: 'Tested', type: 'select' },
    condition_notes: { label: 'Condition notes and defects', type: 'textarea', wide: true },
    bare_length_in: { label: 'Bare L (in)', type: 'num' }, bare_width_in: { label: 'Bare W (in)', type: 'num' }, bare_height_in: { label: 'Bare H (in)', type: 'num' },
    packed_length_in: { label: 'Packed L (in)', type: 'num' }, packed_width_in: { label: 'Packed W (in)', type: 'num' }, packed_height_in: { label: 'Packed H (in)', type: 'num' },
    weight_oz: { label: 'Weight (oz)', type: 'num', hint: '1 lb = 16 oz' }, weight_source: { label: 'Weight source', type: 'select' },
    shipping_class: { label: 'Shipping class', type: 'select' },
    is_oversize: { label: 'Oversize', type: 'bool' }, is_hazmat: { label: 'Hazardous material', type: 'bool' }, local_pickup_only: { label: 'Local pickup only', type: 'bool' },
    asking_price: { label: 'Asking price ($)', type: 'num' },
    shopify_product_id: { label: 'Shopify product id' }, ebay_item_id: { label: 'eBay item number' },
  };
  const SECTIONS = [
    ['Identify the part', ['title', 'system_code', 'brand', 'oem_aftermarket', 'oem_part_number', 'casting_numbers', 'quantity', 'color', 'material', 'description']],
    ['Condition', ['condition_grade', 'tested_status', 'condition_notes']],
    ['Size, weight and shipping', ['bare_length_in', 'bare_width_in', 'bare_height_in', 'packed_length_in', 'packed_width_in', 'packed_height_in', 'weight_oz', 'weight_source', 'shipping_class', 'is_oversize', 'is_hazmat', 'local_pickup_only']],
  ];
  const SLOTS = [
    ['sku_card', 'SKU card (first photo)'], ['overall_front', 'Front'], ['overall_back', 'Back'], ['part_number', 'Part number'],
    ['casting_mark', 'Casting marks'], ['mounting_point', 'Mounting points'], ['connector', 'Connectors'], ['defect', 'Defects'],
    ['measurement', 'Caliper / tape'], ['scale_weight', 'Scale reading'], ['other', 'Other'], ['video', 'Video (optional)'],
  ];
  const SLOT_ORDER = Object.fromEntries(SLOTS.map(([k], i) => [k, i]));
  const TRANSITIONS = {
    draft: [['fitment_review', 'Submit for fitment review', 'intake', 1], ['research_draft', 'Park as research draft', 'intake']],
    research_draft: [['draft', 'Back to draft', 'intake']],
    needs_info: [['fitment_review', 'Resubmit for review', 'intake', 1]],
    fitment_review: [['listing_review', 'Approve fitment & condition', 'fitment_reviewer', 1], ['needs_info', 'Needs info', 'fitment_reviewer'], ['research_draft', 'Unknown: send to research', 'fitment_reviewer']],
    listing_review: [['ready_to_publish', 'Approve listing', 'listing_approver', 1], ['needs_info', 'Needs info', 'listing_approver'], ['fitment_review', 'Back to fitment review', 'listing_approver']],
    ready_to_publish: [['published', 'Mark published on Shopify', 'listing_approver', 1], ['listing_review', 'Back to listing review', 'listing_approver']],
    published: [['sold', 'Mark sold', 'fulfillment'], ['reserved', 'Reserve (paid order / install)', 'fulfillment'], ['listing_review', 'Unpublish to edit', 'listing_approver']],
    reserved: [['sold', 'Mark sold', 'fulfillment', 1], ['published', 'Release reservation', 'fulfillment']],
    sold: [['shipped', 'Mark packed & shipped', 'fulfillment', 1], ['installed', 'Mark installed at SIC', 'fulfillment']],
    on_hold: [['draft', 'Back to draft', 'owner']],
  };

  /* ---------------- helpers ---------------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const has = role => !!S.me && (S.me.roles.includes(role) || S.me.roles.includes('owner'));
  const isReviewer = () => has('fitment_reviewer') || has('listing_approver');
  const nameOf = id => S.names[id] || (id ? 'Unknown' : '');
  const fmt = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const money = v => v === null || v === undefined || v === '' ? '' : '$' + Number(v).toFixed(2);
  const pill = status => h('span', { class: `pill ${status}` }, STATUS[status] || status);
  let flashTimer;
  function flash(msg, kind = 'ok', ms = 4200) {
    $flash.textContent = msg; $flash.className = `flash ${kind}`; $flash.hidden = false;
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { $flash.hidden = true; }, ms);
  }
  const err = e => flash(e?.message || String(e), 'err', 7000);
  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function thumbUrl(m) {
    if (m.bucket === 'external') return m.path.replace(/\/s-l\d+\./, '/s-l300.');
    if (m.bucket === 'wh-marketplace') return A.publicUrl(m.bucket, m.path);
    return null;
  }
  const itemById = id => S.items.find(i => i.id === id);
  const mainImage = item => (S.media[item.id] || []).filter(X.isListingImage)
    .sort((a, b) => (SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]) || a.position - b.position)[0];
  function confirmDialog(title, body, okLabel = 'OK', withNotes = false) {
    return new Promise(resolve => {
      const notes = withNotes ? h('textarea', { placeholder: 'Notes for the history (optional)' }) : null;
      $dialog.replaceChildren(h('h2', {}, title), body ? h('p', {}, body) : null, notes,
        h('div', { class: 'actions mt' },
          h('button', { class: 'btn primary', onclick: () => { $dialog.close(); resolve(withNotes ? { notes: notes.value } : true); } }, okLabel),
          h('button', { class: 'btn', onclick: () => { $dialog.close(); resolve(false); } }, 'Cancel')));
      $dialog.showModal();
    });
  }

  async function fetchAll(table, query) {
    const out = []; const page = 1000;
    for (let offset = 0; ; offset += page) {
      const rows = await A.select(table, `${query}&limit=${page}&offset=${offset}`);
      out.push(...rows);
      if (rows.length < page) return out;
    }
  }
  const groupBy = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = m[r[key]] || []).push(r), m), {});

  /* ---------------- sign-in ---------------- */
  function showSignIn(message) {
    $who.hidden = true;
    const email = h('input', { type: 'email', autocomplete: 'email', required: true });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, minlength: 12 });
    const status = h('p', { role: 'status' }, message || '');
    const form = h('form', { class: 'signin', onsubmit: async e => {
      e.preventDefault(); status.textContent = 'Signing in…';
      try { await A.signIn(email.value.trim(), pw.value); await boot(); } catch (x) { status.textContent = x.message; }
    } },
      h('h2', {}, 'Staff sign-in'),
      h('p', {}, 'Use your normal RIDE account. The warehouse opens only for accounts the owner has added as staff.'),
      h('label', { class: 'field' }, 'Email', email), h('label', { class: 'field' }, 'Password', pw),
      h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'), status);
    $app.replaceChildren(form); email.focus();
  }
  function showNoAccess() {
    $app.replaceChildren(h('div', { class: 'signin' }, h('h2', {}, 'No warehouse access'),
      h('p', {}, 'You are signed in, but this account is not on the warehouse staff list. Ask the owner to add you.'),
      h('button', { class: 'btn', onclick: signOut }, 'Sign out')));
  }
  async function signOut() { await A.signOut(); S.me = null; S.ed = null; showSignIn('Signed out.'); }

  /* ---------------- data ---------------- */
  async function loadRefs() {
    const [systems, families, catMeas, staff] = await Promise.all([
      A.select('wh_systems', 'select=*&order=sort'), A.select('wh_engine_families', 'select=*&order=sort'),
      A.select('wh_category_measurements', 'select=*'), A.select('wh_staff', 'select=user_id,display_name,active&order=display_name'),
    ]);
    Object.assign(S, { systems, families, catMeas, staff });
    S.names = Object.fromEntries(staff.map(s => [s.user_id, s.display_name]));
    if (has('owner')) S.roles = await A.select('wh_staff_roles', 'select=user_id,role');
  }
  async function loadItems() {
    const [items, media, fits] = await Promise.all([
      fetchAll('wh_items', 'select=*&order=updated_at.desc'),
      fetchAll('wh_media', 'select=id,item_id,slot,kind,bucket,path,position,hidden,created_at&order=created_at'),
      fetchAll('wh_fitments', 'select=*&order=created_at'),
    ]);
    S.items = items; S.media = groupBy(media, 'item_id'); S.fitments = groupBy(fits, 'item_id');
  }
  const lookups = () => ({ systems: Object.fromEntries(S.systems.map(s => [s.code, s.label])), families: Object.fromEntries(S.families.map(f => [f.code, f.label])) });

  /* ---------------- shell ---------------- */
  function renderWho() {
    $who.hidden = false;
    $who.replaceChildren(h('span', {}, 'Signed in as ', h('b', {}, S.me.display_name || 'staff'), ' · ', S.me.roles.join(', ')),
      h('button', { class: 'btn small', onclick: signOut }, 'Sign out'));
  }
  function tabs() {
    const t = [['mine', 'My items', () => S.items.filter(i => i.created_by === S.me.user_id).length]];
    if (isReviewer()) t.push(['queues', 'Review queues', () => S.items.filter(i => ['fitment_review', 'listing_review'].includes(i.status)).length]);
    if (isReviewer() || has('fulfillment')) t.push(['master', 'All inventory', () => S.items.length]);
    if (has('intake')) t.push(['import', 'Import from eBay']);
    t.push(['exports', 'Exports & reports'], ['labels', 'Labels & locations']);
    if (has('owner')) t.push(['staff', 'Staff']);
    return t;
  }
  function render() {
    if (S.ed) return renderEditor();
    const bar = h('div', { class: 'tabs', role: 'tablist' }, tabs().map(([k, label, count]) =>
      h('button', { role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; render(); } }, label,
        count ? h('span', { class: 'count' }, count()) : null)));
    const views = { mine: viewMine, queues: viewQueues, master: viewMaster, import: viewImport, exports: viewExports, labels: viewLabels, staff: viewStaff };
    $app.replaceChildren(bar, (views[S.tab] || viewMine)());
  }

  /* ---------------- grids ---------------- */
  const COLS = [
    ['', i => { const m = mainImage(i); const u = m && thumbUrl(m); return u ? h('img', { class: 'thumb', src: u, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb' }); }, null],
    ['SKU', i => h('span', { class: 'mono' }, i.sku), 'sku'],
    ['Title', i => [i.title || h('i', {}, '(untitled)'), i.source === 'ebay_import' ? [' ', h('span', { class: 'pill ebay' }, 'eBay')] : null], 'title', 'title'],
    ['Status', i => pill(i.status), 'status'],
    ['System', i => lookups().systems[i.system_code] || '', 'system_code'],
    ['Fitment', i => (S.fitments[i.id] || []).map(f => X.fitmentLine(f, lookups().families)).join('; ') || (X.FITMENT_STATUS[i.fitment_status] || ''), null],
    ['Condition', i => X.CONDITION[i.condition_grade] || '', 'condition_grade'],
    ['Price', i => money(i.asking_price), 'asking_price'],
    ['Location', i => h('span', { class: 'mono' }, i.location_code || ''), 'location_code'],
    ['Created by', i => nameOf(i.created_by), 'created_by'],
    ['Updated', i => fmt(i.updated_at), 'updated_at'],
  ];
  function grid(items, { emptyText = 'Nothing here yet.' } = {}) {
    const q = S.filter.q.trim().toLowerCase();
    let rows = items.filter(i => (!S.filter.status || i.status === S.filter.status) && (!S.filter.worker || i.created_by === S.filter.worker) &&
      (!q || [i.sku, i.title, i.oem_part_number, i.location_code, i.ebay_item_id, ...(i.casting_numbers || [])].some(v => String(v || '').toLowerCase().includes(q))));
    const { key, dir } = S.sort;
    rows = rows.slice().sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true }) * dir);
    if (!rows.length) return h('div', { class: 'grid-wrap' }, h('p', { class: 'empty' }, emptyText));
    return h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, COLS.map(([label, , k]) => h('th', { onclick: k ? () => { S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : 1 }; render(); } : null },
        label, S.sort.key === k ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : '')))),
      h('tbody', {}, rows.map(i => h('tr', { onclick: () => openItem(i.id) }, COLS.map(([, f, , cls]) => h('td', { class: cls }, f(i))))))),
      h('p', { class: 'hint' }, `${rows.length} of ${items.length} shown`));
  }
  function filterBar({ workers = false, statuses = true } = {}) {
    return h('div', { class: 'toolbar' },
      h('label', { class: 'field grow' }, 'Search SKU, title, part #, location, eBay #',
        h('input', { type: 'search', value: S.filter.q, oninput: e => { S.filter.q = e.target.value; clearTimeout(filterBar.t); filterBar.t = setTimeout(() => { render(); const i = $app.querySelector('input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); } })),
      statuses ? h('label', { class: 'field' }, 'Status', h('select', { onchange: e => { S.filter.status = e.target.value; render(); } },
        h('option', { value: '' }, 'Any'), Object.entries(STATUS).map(([k, v]) => h('option', { value: k, selected: S.filter.status === k }, v)))) : null,
      workers ? h('label', { class: 'field' }, 'Worker', h('select', { onchange: e => { S.filter.worker = e.target.value; render(); } },
        h('option', { value: '' }, 'Everyone'), S.staff.map(s => h('option', { value: s.user_id, selected: S.filter.worker === s.user_id }, s.display_name)))) : null);
  }
  function viewMine() {
    const mine = S.items.filter(i => i.created_by === S.me.user_id);
    return h('section', {},
      h('div', { class: 'toolbar' }, has('intake') ? h('button', { class: 'btn primary', onclick: newItem }, '+ New part') : null,
        h('label', { class: 'field grow' }, 'Open by SKU (scan or type)', h('input', { type: 'text', placeholder: 'SIC-000123', onkeydown: e => {
          if (e.key !== 'Enter') return; const v = e.target.value.trim().toUpperCase(); const it = S.items.find(i => i.sku === v);
          if (it) openItem(it.id); else flash(`No item ${v}.`, 'err');
        } }))),
      filterBar(), grid(mine, { emptyText: 'You have not added any parts yet. Tap “+ New part” to start.' }));
  }
  function viewQueues() {
    const qs = [['fitment_review', 'Fitment review'], ['listing_review', 'Listing review'], ['needs_info', 'Needs info'],
      ['ready_to_publish', 'Ready to publish'], ['research_draft', 'Research drafts'], ['draft', 'Drafts / incomplete']];
    return h('section', {},
      h('div', { class: 'tabs' }, qs.map(([k, l]) => h('button', { 'aria-selected': String(S.queue === k), onclick: () => { S.queue = k; render(); } },
        l, h('span', { class: 'count' }, S.items.filter(i => i.status === k).length)))),
      filterBar({ workers: true, statuses: false }), grid(S.items.filter(i => i.status === S.queue), { emptyText: 'Queue is empty.' }));
  }
  function discrepancies() {
    return S.items.filter(i => (['ready_to_publish', 'published', 'reserved'].includes(i.status) && (!i.location_code || i.quantity < 1)) ||
      (['shipped', 'installed', 'archived'].includes(i.status) && i.quantity > 0 && i.location_code && false) ||
      (i.status === 'published' && !i.shopify_product_id && !i.ebay_item_id));
  }
  function viewMaster() {
    const counts = Object.keys(STATUS).map(k => [k, S.items.filter(i => i.status === k).length]).filter(([, n]) => n);
    const disc = discrepancies();
    return h('section', {},
      h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('b', {}, S.items.length), h('span', {}, 'items in the Bible')),
        counts.map(([k, n]) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, STATUS[k]))),
        h('div', { class: 'stat' }, h('b', {}, disc.length), h('span', {}, 'discrepancies'))),
      h('p', {}), filterBar({ workers: true }), grid(S.items),
      disc.length ? h('div', { class: 'card mt' }, h('h3', {}, 'Discrepancies'),
        h('p', { class: 'hint' }, 'Published or ready items with no location or zero quantity, or published with no Shopify/eBay id.'), grid(disc)) : null);
  }

  /* ---------------- editor ---------------- */
  async function newItem() {
    try {
      const r = await A.rpc('wh_create_item', { p_fields: {} });
      S.items.unshift(r.item); flash(`Created ${r.item.sku}. Put its SKU card in the first photo.`);
      await openItem(r.item.id);
    } catch (e) { err(e); }
  }
  async function openItem(id) {
    try {
      const [[item], fits, meas, media] = await Promise.all([
        A.select('wh_items', `select=*&id=eq.${id}`), A.select('wh_fitments', `select=*&item_id=eq.${id}&order=created_at`),
        A.select('wh_measurements', `select=*&item_id=eq.${id}`), A.select('wh_media', `select=*&item_id=eq.${id}&order=created_at`),
      ]);
      if (!item) return flash('Item not found.', 'err');
      S.ed = { item, base: item, dirty: {}, fits: fits.map(f => ({ ...f })), fitsDirty: false, meas, media, saving: null, state: '', fin: null, blockers: [], history: [] };
      S.media[id] = media; S.fitments[id] = fits;
      renderEditor();
      loadEditorExtras();
      window.scrollTo(0, 0);
    } catch (e) { err(e); }
  }
  async function loadEditorExtras() {
    const ed = S.ed; if (!ed) return;
    const id = ed.item.id;
    try {
      const [blockers, audit, moves, reviews, fin] = await Promise.all([
        A.rpc('wh_publish_blockers', { p_item: id }),
        A.select('wh_audit_log', `select=at,actor,action,changed,table_name&row_pk=eq.${id}&order=id.desc&limit=60`),
        A.select('wh_moves', `select=*&item_id=eq.${id}&order=id.desc`),
        A.select('wh_reviews', `select=*&item_id=eq.${id}&order=id.desc`),
        has('listing_approver') ? A.select('wh_item_financials', `select=*&item_id=eq.${id}`) : Promise.resolve([]),
      ]);
      if (S.ed !== ed) return;
      ed.blockers = blockers || []; ed.fin = fin[0] || {};
      ed.history = [
        ...audit.map(a => {
          const what = { wh_media: 'a photo', wh_fitments: 'a fitment line', wh_measurements: 'a measurement', wh_item_financials: 'private pricing' }[a.table_name];
          const fields = (a.changed || []).filter(c => !['version', 'updated_at', 'updated_by', 'status', 'location_code'].includes(c));
          if (a.table_name === 'wh_items' && a.action === 'update' && !fields.length) return null;  // shown by the move/review lines
          const who = nameOf(a.actor) || 'System';
          const text = a.table_name === 'wh_items'
            ? (a.action === 'insert' ? `${who} created the part` : `${who} changed ${fields.join(', ').replace(/_/g, ' ')}`)
            : `${who} ${a.action === 'insert' ? 'added' : a.action === 'delete' ? 'removed' : 'changed'} ${what || a.table_name.replace('wh_', '')}`;
          return { at: a.at, text };
        }).filter(Boolean),
        ...moves.map(m => ({ at: m.moved_at, text: `${nameOf(m.moved_by)} moved ${m.from_code || '(none)'} → ${m.to_code}${m.reason ? ` (${m.reason})` : ''}` })),
        ...reviews.map(r => ({ at: r.at, text: `${nameOf(r.reviewer)}: ${STATUS[r.from_status]} → ${STATUS[r.to_status]}${r.notes ? ` — “${r.notes}”` : ''}` })),
      ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      renderEditor(true);
    } catch (e) { err(e); }
  }
  function canEdit(status) {
    if (['draft', 'research_draft', 'needs_info'].includes(status)) return has('intake') || isReviewer();
    if (status === 'fitment_review') return isReviewer();
    if (['listing_review', 'ready_to_publish', 'published', 'reserved'].includes(status)) return has('listing_approver');
    return has('owner');
  }
  const fitmentOpen = s => ['draft', 'research_draft', 'needs_info', 'fitment_review'].includes(s);

  function valueOf(key) { const d = S.ed.dirty; return key in d ? d[key] : S.ed.item[key]; }
  function parseInput(def, el) {
    const t = def.type || 'text';
    if (t === 'bool') return el.checked;
    const v = el.value.trim();
    if (t === 'num' || t === 'int') return v === '' ? null : Number(v);
    if (t === 'list') return v ? v.split(',').map(x => x.trim()).filter(Boolean) : [];
    return v === '' ? null : v;
  }
  function fieldEl(key, disabled) {
    const def = FIELD[key], t = def.type || 'text', v = valueOf(key);
    const onchange = e => { S.ed.dirty[key] = parseInput(def, e.target); e.target.closest('.field').classList.add('dirty'); scheduleSave(); };
    let input;
    if (t === 'select') {
      const opts = typeof def.opts === 'function' ? def.opts() : (def.opts || OPT[key] || []);
      input = h('select', { onchange, disabled }, h('option', { value: '' }, '—'), opts.map(([k, l]) => h('option', { value: k, selected: v === k }, l)));
    } else if (t === 'textarea') input = h('textarea', { oninput: onchange, disabled }, v || '');
    else if (t === 'bool') return h('label', { class: 'field check' + (def.wide ? ' wide' : '') }, h('input', { type: 'checkbox', checked: !!v, onchange, disabled }), def.label);
    else input = h('input', { type: t === 'num' || t === 'int' ? 'number' : 'text', inputmode: t === 'num' ? 'decimal' : t === 'int' ? 'numeric' : null,
      step: t === 'num' ? 'any' : t === 'int' ? '1' : null, value: t === 'list' ? (v || []).join(', ') : (v ?? ''), oninput: onchange, disabled });
    return h('label', { class: 'field' + (def.wide ? ' wide' : '') + (key in S.ed.dirty ? ' dirty' : '') }, def.label, input, def.hint ? h('span', { class: 'hint' }, def.hint) : null);
  }

  let saveTimer;
  function scheduleSave() { clearTimeout(saveTimer); setState('Unsaved changes…'); saveTimer = setTimeout(() => save(), 900); }
  function setState(text, bad) { if (!S.ed) return; S.ed.state = text; const el = document.getElementById('save-state'); if (el) { el.textContent = text; el.classList.toggle('err', !!bad); } }
  async function save() {
    const ed = S.ed; if (!ed) return;
    clearTimeout(saveTimer);
    if (ed.saving) { await ed.saving; if (Object.keys(ed.dirty).length) return save(); return; }
    const changes = { ...ed.dirty }; if (!Object.keys(changes).length) return;
    setState('Saving…');
    ed.saving = (async () => {
      try {
        const r = await A.rpc('wh_update_item', { p_id: ed.item.id, p_expected_version: ed.item.version, p_changes: changes });
        if (r.ok) {
          for (const [k, v] of Object.entries(changes)) if (JSON.stringify(ed.dirty[k]) === JSON.stringify(v)) delete ed.dirty[k];
          applyItem(r.item); setState(`Saved ${fmt(r.item.updated_at)}`);
          document.querySelectorAll('.field.dirty').forEach(f => { if (!Object.keys(ed.dirty).length) f.classList.remove('dirty'); });
        } else if (r.conflict) await resolveConflict(r.current, changes);
      } catch (e) { setState(e.message, true); err(e); }
    })();
    await ed.saving; ed.saving = null;
    if (S.ed === ed && Object.keys(ed.dirty).length && ed.state !== 'Conflict') scheduleSave();
  }
  function applyItem(item) {
    const ed = S.ed; if (!ed || ed.item.id !== item.id) return;
    ed.item = item; ed.base = item;
    const i = S.items.findIndex(x => x.id === item.id); if (i >= 0) S.items[i] = item; else S.items.unshift(item);
  }
  // Someone else saved first. Fields they did not touch are re-applied automatically;
  // fields both people changed are shown side by side.
  async function resolveConflict(current, mine) {
    const ed = S.ed, before = ed.base;
    const theirs = Object.keys(current).filter(k => JSON.stringify(current[k]) !== JSON.stringify(before[k]) && !['version', 'updated_at', 'updated_by'].includes(k));
    const clash = Object.keys(mine).filter(k => theirs.includes(k) && JSON.stringify(current[k]) !== JSON.stringify(mine[k]));
    applyItem(current);
    if (!clash.length) { setState('Merged with a newer save…'); return; }
    ed.state = 'Conflict';
    const who = nameOf(current.updated_by);
    const keepMine = await new Promise(resolve => {
      $dialog.replaceChildren(h('h2', {}, `${who} saved this part while you were editing`),
        h('p', {}, 'These fields were changed by both of you. Choose which copy to keep.'),
        h('table', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, `${who}'s value`), h('th', {}, 'Your value')),
          clash.map(k => h('tr', {}, h('td', {}, FIELD[k]?.label || k), h('td', {}, JSON.stringify(current[k]) ?? ''), h('td', {}, JSON.stringify(mine[k]) ?? '')))),
        h('div', { class: 'actions mt' },
          h('button', { class: 'btn primary', onclick: () => { $dialog.close(); resolve(true); } }, 'Keep mine'),
          h('button', { class: 'btn', onclick: () => { $dialog.close(); resolve(false); } }, `Keep ${who}'s`)));
      $dialog.showModal();
    });
    if (!keepMine) clash.forEach(k => delete ed.dirty[k]);
    ed.state = ''; renderEditor(true);
  }
  async function flushSave() { if (S.ed && Object.keys(S.ed.dirty).length) await save(); if (S.ed?.saving) await S.ed.saving; }

  function renderEditor(keepScroll) {
    const ed = S.ed, it = ed.item, editable = canEdit(it.status), y = window.scrollY;
    const back = h('button', { class: 'btn small', onclick: async () => { await flushSave(); S.ed = null; render(); } }, '← Back');
    const head = h('div', { class: 'editor-head' }, back, h('span', { class: 'sku' }, it.sku), pill(it.status),
      it.source === 'ebay_import' ? h('a', { class: 'pill ebay', href: `https://www.ebay.com/itm/${encodeURIComponent(it.ebay_item_id)}`, target: '_blank', rel: 'noopener' }, `eBay ${it.ebay_item_id}`) : null,
      h('button', { class: 'btn small', onclick: () => printLabels([it.sku], 'sku') }, 'Print SKU card'),
      h('span', { id: 'save-state', class: 'save-state' }, ed.state || (editable ? 'Changes save automatically' : 'Read-only in this status')));

    const left = h('div', { class: 'stack' },
      SECTIONS.map(([title, keys]) => h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'fields' }, keys.map(k => fieldEl(k, !editable))))),
      fitmentCard(editable), measurementCard(editable), photoCard(editable));
    const right = h('div', { class: 'stack' }, statusCard(), locationCard(), priceCard(editable), historyCard());
    $app.replaceChildren(head, h('div', { class: 'editor' }, left, right));
    if (keepScroll) window.scrollTo(0, y);
  }

  function fitmentCard(editable) {
    const ed = S.ed, open = editable && fitmentOpen(ed.item.status);
    const rows = ed.fits.map((f, idx) => {
      const set = (k, parse = v => v) => e => { f[k] = parse(e.target.value); ed.fitsDirty = true; saveFitBtn.disabled = false; };
      return h('div', { class: 'fit-row' },
        h('label', { class: 'field' }, 'Make', h('input', { type: 'text', value: f.make || 'Harley-Davidson', oninput: set('make'), disabled: !open })),
        h('label', { class: 'field' }, 'Engine family', h('select', { onchange: set('engine_family'), disabled: !open }, h('option', { value: '' }, '—'),
          S.families.map(x => h('option', { value: x.code, selected: f.engine_family === x.code }, x.label)))),
        h('label', { class: 'field' }, 'Platform', h('input', { type: 'text', value: f.platform || '', placeholder: 'FLH Touring', oninput: set('platform'), disabled: !open })),
        h('label', { class: 'field' }, 'Model codes', h('input', { type: 'text', value: f.model_codes || '', placeholder: 'FLHTC, FLHR', oninput: set('model_codes'), disabled: !open })),
        h('label', { class: 'field' }, 'Start year', h('input', { type: 'number', value: f.start_year || '', oninput: set('start_year'), disabled: !open })),
        h('label', { class: 'field' }, 'End year', h('input', { type: 'number', value: f.end_year || '', oninput: set('end_year'), disabled: !open })),
        h('label', { class: 'field' }, 'Conditions', h('input', { type: 'text', value: f.conditions || '', oninput: set('conditions'), disabled: !open })),
        h('label', { class: 'field' }, 'Does not fit', h('input', { type: 'text', value: f.exclusions || '', oninput: set('exclusions'), disabled: !open })),
        open ? h('button', { class: 'btn small danger', onclick: () => { ed.fits.splice(idx, 1); ed.fitsDirty = true; renderEditor(true); } }, 'Remove') : null);
    });
    const saveFitBtn = h('button', { class: 'btn primary small', disabled: !ed.fitsDirty, onclick: saveFitments }, 'Save fitment list');
    const ai = ed.item.ai_suggestion;
    return h('div', { class: 'card' }, h('h3', {}, 'Fitment'),
      h('div', { class: 'fields' }, ['fitment_status', 'fitment_evidence_level', 'fitment_evidence_source'].map(k => fieldEl(k, !open))),
      ai ? h('p', { class: 'hint' }, `Suggestion from ${ai.source === 'title_parse' ? 'the eBay title' : 'AI'} (not verified): `,
        [ai.part_number && `PN ${ai.part_number}`, ai.engine_family && (lookups().families[ai.engine_family] || ai.engine_family), ai.years].filter(Boolean).join(' · ') || 'none') : null,
      rows, open ? h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => { ed.fits.push({ make: 'Harley-Davidson', engine_family: ai?.engine_family || '' }); ed.fitsDirty = true; renderEditor(true); } }, '+ Add fitment (years / model)'),
        saveFitBtn) : (fitmentOpen(ed.item.status) ? null : h('p', { class: 'hint' }, 'Fitment is locked after fitment review.')));
  }
  async function saveFitments() {
    await flushSave();
    const ed = S.ed;
    try {
      const r = await A.rpc('wh_save_fitments', { p_item: ed.item.id, p_expected_version: ed.item.version, p_rows: ed.fits });
      if (!r.ok) { applyItem(r.current); return flash('Someone else just saved this part. Check the fitment list and save again.', 'err'); }
      applyItem(r.item); ed.fitsDirty = false;
      ed.fits = (await A.select('wh_fitments', `select=*&item_id=eq.${ed.item.id}&order=created_at`)); S.fitments[ed.item.id] = ed.fits.map(f => ({ ...f }));
      flash('Fitment saved.'); renderEditor(true); loadEditorExtras();
    } catch (e) { err(e); }
  }

  function measurementCard(editable) {
    const ed = S.ed, req = S.catMeas.filter(c => c.system_code === valueOf('system_code'));
    const keys = [...req.map(c => ({ key: c.key, label: c.label, unit: c.unit, required: c.required })),
      ...ed.meas.filter(m => !req.some(c => c.key === m.key)).map(m => ({ key: m.key, label: m.key.replace(/_/g, ' '), unit: m.unit }))];
    const row = c => {
      const m = ed.meas.find(x => x.key === c.key) || {};
      const val = h('input', { type: 'number', step: 'any', inputmode: 'decimal', value: m.value ?? '', disabled: !editable });
      const method = h('select', { disabled: !editable }, OPT.method.map(([k, l]) => h('option', { value: k, selected: (m.method || 'caliper') === k }, l)));
      const store = async () => {
        try {
          await A.rpc('wh_save_measurement', { p_item: ed.item.id, p_key: c.key, p_value: val.value === '' ? null : Number(val.value), p_unit: c.unit, p_method: method.value });
          ed.meas = await A.select('wh_measurements', `select=*&item_id=eq.${ed.item.id}`); flash(`${c.label} saved.`); loadEditorExtras();
        } catch (e) { err(e); }
      };
      val.addEventListener('change', store); method.addEventListener('change', () => val.value !== '' && store());
      return h('div', { class: 'fields' }, h('label', { class: 'field' }, `${c.label} (${c.unit})${c.required ? ' *' : ''}`, val), h('label', { class: 'field' }, 'Measured with', method));
    };
    const newKey = h('input', { type: 'text', placeholder: 'e.g. bolt_spacing' }), newUnit = h('select', {}, ['in', 'mm', 'oz', 'lb', 'teeth', 'splines', 'count'].map(u => h('option', { value: u }, u)));
    return h('div', { class: 'card' }, h('h3', {}, 'Critical measurements'),
      h('p', { class: 'hint' }, 'Measure by hand. Photo estimates never count toward publishing. * = required for this category.'),
      keys.length ? keys.map(row) : h('p', { class: 'hint' }, 'No required measurements for this category.'),
      editable ? h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Add another measurement', newKey), h('label', { class: 'field' }, 'Unit', newUnit),
        h('button', { class: 'btn small', onclick: () => {
          const k = newKey.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          if (!/^[a-z0-9_]{2,40}$/.test(k)) return flash('Use 2-40 letters, numbers or underscores.', 'err');
          ed.meas.push({ key: k, unit: newUnit.value }); renderEditor(true);
        } }, 'Add')) : null);
  }

  function photoCard(editable) {
    const ed = S.ed, imported = ed.item.source === 'ebay_import';
    const required = imported ? ['sku_card'] : ['sku_card', 'overall_front', 'overall_back'];
    const media = ed.media.filter(m => !m.hidden);
    const slots = SLOTS.map(([slot, label]) => {
      const ms = media.filter(m => m.slot === slot && m.bucket !== 'wh-originals' || (m.slot === slot && m.bucket === 'wh-originals' && !media.some(x => x.derived_from === m.id)));
      const filled = media.some(m => m.slot === slot && (m.bucket === 'wh-originals' || m.bucket === 'external'));
      const input = h('input', { type: 'file', accept: slot === 'video' ? 'video/*' : 'image/*', capture: 'environment', multiple: slot !== 'sku_card', disabled: !editable,
        onchange: e => { [...e.target.files].forEach(f => queueUpload(slot, f)); e.target.value = ''; } });
      return h('div', { class: 'slot' + (filled ? ' done' : '') + (required.includes(slot) ? ' req' : '') },
        h('span', { class: 'name' }, label, required.includes(slot) ? ' *' : ''),
        h('div', { class: 'imgs' }, ms.map(m => {
          const u = thumbUrl(m);
          return u ? h('img', { src: u, alt: label, title: editable ? 'Tap to hide this photo' : '', onclick: editable ? () => hidePhoto(m) : null })
            : h('span', { class: 'pill' }, m.kind === 'video' ? 'video' : 'original');
        })),
        editable ? h('span', { class: 'btn small file' }, slot === 'video' ? 'Add video' : 'Add photo', input) : null);
    });
    const ebayBox = h('textarea', { placeholder: 'Paste eBay photo links (https://i.ebayimg.com/...), one per line' });
    return h('div', { class: 'card' }, h('h3', {}, 'Photos'),
      h('p', { class: 'hint' }, imported
        ? 'Imported from eBay: the eBay photos are reused. Add a photo of the part with its SKU card so we know it is here and labelled.'
        : 'Shoot on the 1-inch grid mat. SKU card in the first photo, then front and back, part numbers, mounts, connectors, defects and measurements.'),
      h('div', { class: 'slots' }, slots),
      S.uploads.length ? h('div', { class: 'uploads' }, S.uploads.filter(u => u.itemId === ed.item.id).map(u =>
        h('div', { class: u.error ? 'err' : '' }, `${u.name}: ${u.error || u.status}`, u.error ? h('button', { class: 'link', onclick: () => runUpload(u) }, ' Retry') : null))) : null,
      editable ? h('details', {}, h('summary', {}, 'Add photos from the eBay listing'), ebayBox,
        h('button', { class: 'btn small', onclick: () => addEbayPhotos(ebayBox.value) }, 'Add eBay photos')) : null);
  }
  async function hidePhoto(m) {
    if (!await confirmDialog('Hide this photo?', 'It stays in storage and the history, but will not be used for listings.', 'Hide')) return;
    try { await A.rpc('wh_hide_media', { p_id: m.id, p_hidden: true }); await refreshMedia(); } catch (e) { err(e); }
  }
  async function refreshMedia() {
    const ed = S.ed; if (!ed) return;
    ed.media = await A.select('wh_media', `select=*&item_id=eq.${ed.item.id}&order=created_at`);
    S.media[ed.item.id] = ed.media; renderEditor(true); loadEditorExtras();
  }
  async function addEbayPhotos(text) {
    const urls = IM.imageUrls(text.replace(/\s+/g, '|'));
    if (!urls.length) return flash('No eBay image links found (they start with https://i.ebayimg.com/).', 'err');
    const ed = S.ed, start = ed.media.filter(m => m.bucket === 'external').length;
    try {
      for (const [n, url] of urls.entries()) {
        await A.rpc('wh_add_media', { p_id: crypto.randomUUID(), p_item: ed.item.id, p_slot: start + n === 0 ? 'overall_front' : 'other',
          p_kind: 'photo', p_bucket: 'external', p_path: url, p_bytes: null, p_sha256: null, p_derived_from: null, p_position: start + n + 1 });
      }
      flash(`${urls.length} eBay photo(s) added.`); await refreshMedia();
    } catch (e) { err(e); }
  }

  /* uploads: original to the private bucket, a resized copy with no EXIF/GPS to the public one */
  function queueUpload(slot, file) {
    const ed = S.ed;
    const u = { id: crypto.randomUUID(), itemId: ed.item.id, sku: ed.item.sku, slot, file, name: file.name || slot, status: 'waiting', error: '' };
    S.uploads.push(u); runUpload(u);
  }
  async function runUpload(u) {
    u.error = ''; u.status = 'uploading'; if (S.ed?.item.id === u.itemId) renderEditor(true);
    try {
      const isVideo = u.file.type.startsWith('video/');
      const ext = (u.file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('quicktime', 'mov').replace(/[^a-z0-9]/g, '');
      const bytes = new Uint8Array(await u.file.arrayBuffer());
      const sha = await X.sha256Hex(bytes);
      const path = `items/${u.sku}/${u.slot}/${u.id}.${ext}`;
      if (!u.origDone) { await A.upload('wh-originals', path, u.file, u.file.type || 'image/jpeg'); u.origDone = true; }
      const count = (S.media[u.itemId] || []).filter(m => m.slot === u.slot).length;
      await A.rpc('wh_add_media', { p_id: u.id, p_item: u.itemId, p_slot: u.slot, p_kind: isVideo ? 'video' : 'photo', p_bucket: 'wh-originals',
        p_path: path, p_bytes: bytes.length, p_sha256: sha, p_derived_from: null, p_position: SLOT_ORDER[u.slot] * 10 + count });
      if (!isVideo && u.slot !== 'sku_card') {
        u.status = 'making listing copy';
        const copy = await marketplaceCopy(u.file);
        if (copy) {
          const id2 = u.copyId || (u.copyId = crypto.randomUUID());
          const p2 = `items/${u.sku}/${u.slot}/${id2}.jpg`;
          if (!u.copyDone) { await A.upload('wh-marketplace', p2, copy, 'image/jpeg'); u.copyDone = true; }
          await A.rpc('wh_add_media', { p_id: id2, p_item: u.itemId, p_slot: u.slot, p_kind: 'photo', p_bucket: 'wh-marketplace', p_path: p2,
            p_bytes: copy.size, p_sha256: await X.sha256Hex(new Uint8Array(await copy.arrayBuffer())), p_derived_from: u.id, p_position: SLOT_ORDER[u.slot] * 10 + count });
        } else u.note = 'original saved; this format could not be resized here';
      }
      u.status = u.note || 'done';
      S.uploads = S.uploads.filter(x => x !== u || x.error);
      if (S.ed?.item.id === u.itemId) await refreshMedia();
    } catch (e) { u.error = e.message; if (S.ed?.item.id === u.itemId) renderEditor(true); }
  }
  // Re-encoding through a canvas drops EXIF (including GPS). Longest side 2048 px.
  async function marketplaceCopy(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      src = await new Promise(res => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = URL.createObjectURL(file); });
    }
    if (!src) return null;
    const w0 = src.width, h0 = src.height, scale = Math.min(1, 2048 / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.round(w0 * scale); c.height = Math.round(h0 * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.86));
  }

  function statusCard() {
    const ed = S.ed, it = ed.item;
    const moves = (TRANSITIONS[it.status] || []).filter(([, , role]) => has(role));
    if (has('owner') && !['archived', 'on_hold'].includes(it.status)) moves.push(['on_hold', 'Put on hold', 'owner'], ['archived', 'Archive', 'owner']);
    const openStatus = ['draft', 'research_draft', 'needs_info', 'fitment_review', 'listing_review'].includes(it.status);
    return h('div', { class: 'card' }, h('h3', {}, 'Status & next step'), h('div', {}, pill(it.status)),
      openStatus ? (ed.blockers.length ? [h('p', { class: 'hint' }, 'Still needed before it can be published:'), h('ul', { class: 'blockers' }, ed.blockers.map(b => h('li', {}, b)))]
        : h('ul', { class: 'blockers ok' }, h('li', {}, '✓ Everything needed to publish is here.'))) : null,
      h('div', { class: 'actions' }, moves.map(([to, label, , primary]) => h('button', { class: 'btn' + (primary ? ' primary' : '') + (to === 'archived' ? ' danger' : ''), onclick: () => transition(to, label) }, label))),
      h('p', { class: 'hint' }, `Created by ${nameOf(it.created_by)} ${fmt(it.created_at)} · last edit ${nameOf(it.updated_by)} ${fmt(it.updated_at)}`),
      [['Fitment verified', 'fitment_verified'], ['Condition graded', 'condition_graded'], ['Listing approved', 'listing_approved'], ['Published', 'published'], ['Picked', 'picked'], ['Packed', 'packed']]
        .filter(([, k]) => it[k + '_by']).map(([l, k]) => h('p', { class: 'hint' }, `${l} by ${nameOf(it[k + '_by'])} ${fmt(it[k + '_at'])}`)));
  }
  async function transition(to, label) {
    await flushSave();
    const r = await confirmDialog(label, `${S.ed.item.sku}: ${STATUS[S.ed.item.status]} → ${STATUS[to]}`, label, true);
    if (!r) return;
    try {
      const res = await A.rpc('wh_transition', { p_item: S.ed.item.id, p_to: to, p_notes: r.notes || null });
      applyItem(res.item); flash(`${res.item.sku} is now ${STATUS[to]}.`); renderEditor(true); loadEditorExtras();
    } catch (e) { err(e); }
  }

  const LOC_RE = /^WH(\d{1,2})-R(\d{1,2})-S(\d{1,2})-B(\d{1,2})$/i;
  async function ensureLocation(code) {
    const m = String(code).trim().toUpperCase().match(LOC_RE);
    if (!m) throw new Error('Location must look like WH1-R03-S02-B07.');
    return A.rpc('wh_upsert_location', { p_warehouse: 'WH' + Number(m[1]), p_row: +m[2], p_shelf: +m[3], p_bin: +m[4] });
  }
  function locationCard() {
    const ed = S.ed, can = has('intake') || has('fulfillment');
    const input = h('input', { type: 'text', placeholder: 'Scan bin label or type WH1-R03-S02-B07', autocapitalize: 'characters',
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); move(); } } });
    const reason = h('input', { type: 'text', placeholder: 'Reason (optional)' });
    async function move() {
      try {
        const code = await ensureLocation(input.value);
        const r = await A.rpc('wh_move_item', { p_item: ed.item.id, p_to_code: code, p_reason: reason.value || null });
        applyItem(r.item); flash(`${ed.item.sku} is at ${code}.`); renderEditor(true); loadEditorExtras();
      } catch (e) { err(e); }
    }
    return h('div', { class: 'card' }, h('h3', {}, 'Warehouse location'),
      h('div', { class: 'loc-code mono' }, ed.item.location_code || 'Not shelved yet'),
      can ? [h('label', { class: 'field' }, ed.item.location_code ? 'Move to' : 'Shelve at', input), h('label', { class: 'field' }, 'Reason', reason),
        h('button', { class: 'btn', onclick: move }, ed.item.location_code ? 'Move' : 'Set location')] : null);
  }
  function priceCard(editable) {
    const ed = S.ed;
    const fin = ed.fin || {};
    const cost = h('input', { type: 'number', step: 'any', value: fin.cost ?? '' }), cons = h('input', { type: 'text', value: fin.consignor ?? '' }),
      min = h('input', { type: 'number', step: 'any', value: fin.min_approved_price ?? '' });
    return h('div', { class: 'card' }, h('h3', {}, 'Price'), h('div', { class: 'fields' }, fieldEl('asking_price', !editable)),
      has('listing_approver') ? [h('p', { class: 'hint' }, 'Private: only approvers and owners can see these.'),
        h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Cost ($)', cost), h('label', { class: 'field' }, 'Consignor', cons), h('label', { class: 'field' }, 'Minimum approved price ($)', min)),
        h('button', { class: 'btn small', onclick: async () => {
          try { await A.rpc('wh_set_financials', { p_item: ed.item.id, p_cost: cost.value === '' ? null : +cost.value, p_consignor: cons.value, p_min_price: min.value === '' ? null : +min.value }); flash('Saved.'); loadEditorExtras(); } catch (e) { err(e); }
        } }, 'Save private pricing'),
        h('div', { class: 'fields' }, fieldEl('shopify_product_id', !has('listing_approver') || !editable), fieldEl('ebay_item_id', !has('listing_approver') || !editable))] : null);
  }
  function historyCard() {
    return h('div', { class: 'card' }, h('h3', {}, 'History'),
      h('div', { class: 'history' }, S.ed.history.length ? S.ed.history.map(x => h('div', {}, h('time', {}, fmt(x.at)), ' ', x.text)) : h('span', { class: 'hint' }, 'Loading…')));
  }

  /* ---------------- eBay import ---------------- */
  function viewImport() {
    const file = h('input', { type: 'file', accept: '.csv,text/csv', onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      const { rows, error } = IM.ebayRows(await f.text());
      if (error) return flash(error, 'err', 9000);
      const known = new Set(S.items.map(i => i.ebay_item_id).filter(Boolean));
      rows.forEach(r => { r.already = known.has(r.ebay_item_id); if (r.already) r.include = false; });
      S.importRows = rows; render();
    } });
    const rows = S.importRows;
    const body = rows ? [
      h('div', { class: 'toolbar' },
        h('b', {}, `${rows.filter(r => r.include).length} selected of ${rows.length} listings`),
        h('button', { class: 'btn small', onclick: () => { rows.forEach(r => { r.include = !r.already && r.hints.looks_like_motorcycle; }); render(); } }, 'Select motorcycle parts'),
        h('button', { class: 'btn small', onclick: () => { rows.forEach(r => { r.include = !r.already; }); render(); } }, 'Select all'),
        h('button', { class: 'btn small', onclick: () => { rows.forEach(r => { r.include = false; }); render(); } }, 'Select none'),
        h('button', { class: 'btn primary', onclick: runImport }, 'Import selected as drafts')),
      h('div', { class: 'grid-wrap import-list' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['', 'eBay #', 'Title', 'Price', 'Qty', 'Part # (guess)', 'Family (guess)', 'System (guess)', 'Photos'].map(t => h('th', {}, t)))),
        h('tbody', {}, rows.map(r => h('tr', {},
          h('td', {}, r.already ? h('span', { class: 'pill' }, 'imported') : h('input', { type: 'checkbox', checked: r.include, onchange: e => { r.include = e.target.checked; } })),
          h('td', { class: 'mono' }, r.ebay_item_id), h('td', { class: 'title' }, r.title), h('td', {}, money(r.price)), h('td', {}, r.quantity),
          h('td', { class: 'mono' }, r.part_number), h('td', {}, lookups().families[r.hints.engine_family] || ''), h('td', {}, lookups().systems[r.system_code] || ''),
          h('td', {}, r.image_urls.length || '')))))),
    ] : null;
    return h('section', { class: 'stack' }, h('div', { class: 'card' }, h('h2', {}, 'Import listings from eBay (SW Odds and Ends)'),
      h('p', {}, 'In eBay Seller Hub open Reports → Downloads, download “All active listings” as CSV, and choose it here. Nothing is sent to eBay and the eBay listings stay live.'),
      h('p', { class: 'hint' }, 'Each listing becomes a draft with a permanent SIC SKU and keeps its eBay item number, so it cannot be imported twice. Part numbers, engine family and category read from titles are guesses for the reviewer; they never count as verified fitment. Car parts, antiques and other non-motorcycle listings start unselected.'),
      h('label', { class: 'field' }, 'Active listings report (.csv)', file)), body);
  }
  async function runImport() {
    const sel = S.importRows.filter(r => r.include && !r.already);
    if (!sel.length) return flash('Nothing selected.', 'err');
    if (!await confirmDialog(`Import ${sel.length} listings?`, 'They become drafts in the warehouse. eBay is not changed.', 'Import')) return;
    let created = 0; const skipped = [];
    try {
      for (let i = 0; i < sel.length; i += 200) {
        const batch = sel.slice(i, i + 200).map(r => ({ ebay_item_id: r.ebay_item_id, title: r.title, price: r.price, quantity: r.quantity,
          condition: r.condition, part_number: r.part_number, system_code: r.system_code, image_urls: r.image_urls,
          hints: { ...r.hints, category: r.category, custom_label: r.custom_label } }));
        flash(`Importing ${i + 1}–${Math.min(i + 200, sel.length)} of ${sel.length}…`, 'ok', 60000);
        const r = await A.rpc('wh_import_ebay', { p_rows: batch });
        created += r.created; skipped.push(...r.skipped);
      }
      await loadItems(); S.importRows = null;
      flash(`Imported ${created} drafts.${skipped.length ? ` Skipped ${skipped.length} (already imported or missing data).` : ''}`, 'ok', 9000);
      S.tab = 'mine'; render();
    } catch (e) { err(e); }
  }

  /* ---------------- exports ---------------- */
  async function logAndDownload(kind, filters, rowCount, name, data, type) {
    const sha = await X.sha256Hex(typeof data === 'string' ? data : data);
    await A.rpc('wh_log_export', { p_kind: kind, p_filters: filters, p_row_count: rowCount, p_sha256: sha });
    download(name, data, type);
    flash(`${name} downloaded (${rowCount} rows).`);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  async function ctx(withFinancials) {
    const c = { lookups: lookups(), names: S.names, fitmentsByItem: S.fitments, mediaByItem: S.media, baseUrl: A.baseUrl() };
    if (withFinancials && has('listing_approver')) c.financials = Object.fromEntries((await fetchAll('wh_item_financials', 'select=*')).map(f => [f.item_id, f]));
    return c;
  }
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  async function exportMaster(format) {
    try {
      await loadItems(); const c = await ctx(true);
      const by = st => S.items.filter(i => st.includes(i.status));
      const sheets = [['All items', S.items], ['Drafts & incomplete', by(['draft', 'research_draft', 'needs_info'])], ['Fitment review', by(['fitment_review'])],
        ['Listing review', by(['listing_review'])], ['Ready to publish', by(['ready_to_publish'])], ['Published', by(['published', 'reserved'])],
        ['Sold', by(['sold', 'shipped', 'installed'])], ['Discrepancies', discrepancies()],
        ...S.staff.map(s => [`Worker ${s.display_name}`, S.items.filter(i => i.created_by === s.user_id)])];
      if (format === 'csv') { const t = X.itemTable(S.items, c); return logAndDownload('master_csv', {}, t.rows.length, `fangs-master-${stamp()}.csv`, X.csv(t.rows, t.headers), 'text/csv'); }
      const bytes = X.xlsx(sheets.map(([name, items]) => ({ name, ...X.itemTable(items, c) })));
      await logAndDownload('master_xlsx', {}, S.items.length, `fangs-master-${stamp()}.xlsx`, bytes, XLSX_TYPE);
    } catch (e) { err(e); }
  }
  async function exportWorker(userId) {
    try {
      await loadItems(); const c = await ctx(false);
      const items = S.items.filter(i => i.created_by === userId), name = (S.names[userId] || 'worker').replace(/[^A-Za-z0-9]+/g, '-');
      const bytes = X.xlsx([{ name: `${S.names[userId] || 'Worker'} items`, ...X.itemTable(items, c) }]);
      await logAndDownload('worker_xlsx', { worker: userId }, items.length, `fangs-${name}-${stamp()}.xlsx`, bytes, XLSX_TYPE);
    } catch (e) { err(e); }
  }
  async function exportShopify() {
    try {
      await loadItems();
      const items = S.items.filter(i => i.status === 'ready_to_publish');
      const out = X.shopifyCsv(items, S.fitments, S.media, lookups(), A.baseUrl());
      const n = new Set(out.rows.map(r => r['URL handle'])).size;
      if (!n) return flash(`No items ready to export.${out.skipped.length ? ` ${out.skipped.length} skipped: ${out.skipped.map(s => `${s.sku} (${s.reason})`).join(', ')}` : ''}`, 'err', 9000);
      await logAndDownload('shopify_csv', { status: 'ready_to_publish', skus: items.map(i => i.sku) }, n, `shopify-draft-import-${stamp()}.csv`, out.csv, 'text/csv');
      $dialog.replaceChildren(h('h2', {}, `Shopify file ready: ${n} products (Draft)`),
        h('ol', {}, h('li', {}, 'Shopify admin → Products → Import → choose this file.'),
          h('li', {}, 'Tick “Overwrite products with matching handles” only when re-importing SIC SKUs (handles start with sic-).'),
          h('li', {}, 'Products arrive as Draft. Check a few, then set them Active in Shopify.'),
          h('li', {}, 'These parts are still listed on eBay. When one sells in either place, end or zero it in the other right away.')),
        h('p', {}, 'After the import succeeds, mark these parts Published here so they leave the queue.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: async () => {
            $dialog.close(); let ok = 0;
            for (const i of items.filter(i => out.rows.some(r => r.SKU === i.sku))) {
              try { await A.rpc('wh_transition', { p_item: i.id, p_to: 'published', p_notes: 'Imported to Shopify via CSV' }); ok++; } catch (e) { err(e); }
            }
            await loadItems(); flash(`${ok} parts marked Published.`); render();
          } }, 'Import worked: mark them Published'),
          h('button', { class: 'btn', onclick: () => $dialog.close() }, 'Not yet')));
      $dialog.showModal();
    } catch (e) { err(e); }
  }
  async function exportReport(kind) {
    try {
      await loadItems(); let rows, headers, name;
      if (kind === 'missing_info') {
        const r = await A.rpc('wh_blockers_report', {});
        headers = ['SKU', 'Title', 'Status', 'Created by', 'Location', 'Missing'];
        rows = r.map(x => ({ SKU: x.sku, Title: x.title, Status: STATUS[x.status], 'Created by': nameOf(x.created_by), Location: x.location_code, Missing: (x.blockers || []).join('; ') }));
        name = 'missing-info';
      } else if (kind === 'fitment_review') {
        headers = ['SKU', 'Title', 'Status', 'Part #', 'Fitment status', 'Evidence', 'Source', 'Applications', 'Created by'];
        rows = S.items.filter(i => ['fitment_review', 'needs_info', 'research_draft'].includes(i.status)).map(i => ({ SKU: i.sku, Title: i.title, Status: STATUS[i.status],
          'Part #': i.oem_part_number, 'Fitment status': X.FITMENT_STATUS[i.fitment_status] || '', Evidence: i.fitment_evidence_level, Source: i.fitment_evidence_source,
          Applications: (S.fitments[i.id] || []).map(f => X.fitmentLine(f, lookups().families)).join('; '), 'Created by': nameOf(i.created_by) }));
        name = 'fitment-review';
      } else {
        headers = ['Location', 'SKU', 'Title', 'Status', 'Qty'];
        rows = S.items.filter(i => !['shipped', 'installed', 'archived'].includes(i.status))
          .sort((a, b) => String(a.location_code || 'ZZ').localeCompare(String(b.location_code || 'ZZ')))
          .map(i => ({ Location: i.location_code || '(not shelved)', SKU: i.sku, Title: i.title, Status: STATUS[i.status], Qty: i.quantity }));
        name = 'location-report';
      }
      await logAndDownload(kind, {}, rows.length, `fangs-${name}-${stamp()}.csv`, X.csv(rows, headers), 'text/csv');
    } catch (e) { err(e); }
  }
  function viewExports() {
    const hist = h('div', { class: 'grid-wrap' }, h('p', { class: 'empty' }, 'Loading export history…'));
    A.select('wh_exports', 'select=*&order=id.desc&limit=50').then(rows => hist.replaceChildren(rows.length ? h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['When', 'Who', 'Kind', 'Rows', 'SHA-256'].map(t => h('th', {}, t)))),
      h('tbody', {}, rows.map(r => h('tr', {}, h('td', {}, fmt(r.created_at)), h('td', {}, nameOf(r.created_by)), h('td', {}, r.kind), h('td', {}, r.row_count), h('td', { class: 'mono' }, (r.sha256 || '').slice(0, 12)))))) : h('p', { class: 'empty' }, 'No exports yet.'))).catch(err);
    const worker = h('select', {}, S.staff.map(s => h('option', { value: s.user_id, selected: s.user_id === S.me.user_id }, s.display_name)));
    return h('section', { class: 'stack' },
      h('div', { class: 'card' }, h('h2', {}, 'Spreadsheets'), h('p', { class: 'hint' }, 'The database is the master record. These files are snapshots with image links, never separate masters.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => exportWorker(S.me.user_id) }, 'My items (XLSX)'),
          isReviewer() || has('owner') ? [h('button', { class: 'btn', onclick: () => exportMaster('xlsx') }, 'Master workbook (XLSX)'),
            h('button', { class: 'btn', onclick: () => exportMaster('csv') }, 'Master (CSV)'),
            h('label', { class: 'field' }, 'Worker workbook', worker), h('button', { class: 'btn', onclick: () => exportWorker(worker.value) }, 'Download worker XLSX')] : null)),
      h('div', { class: 'card' }, h('h2', {}, 'Reports'), h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => exportReport('missing_info') }, 'Missing-information report'),
        h('button', { class: 'btn', onclick: () => exportReport('fitment_review') }, 'Fitment-review report'),
        h('button', { class: 'btn', onclick: () => exportReport('location_report') }, 'Location / bin report'))),
      has('listing_approver') ? h('div', { class: 'card' }, h('h2', {}, 'Shopify'),
        h('p', {}, `${S.items.filter(i => i.status === 'ready_to_publish').length} parts are Ready to publish.`),
        h('p', { class: 'hint' }, 'Builds a Shopify product CSV with every product set to Draft, handle = SIC SKU (e.g. sic-000123), quantity tracked, never oversold. Nothing goes live until you set it Active in Shopify.'),
        h('button', { class: 'btn primary', onclick: exportShopify }, 'Download Shopify CSV (Draft)')) : null,
      h('div', { class: 'card' }, h('h2', {}, 'Export history'), hist));
  }

  /* ---------------- labels & locations ---------------- */
  function printLabels(codes, kind) {
    let box = document.getElementById('print-area');
    if (!box) { box = h('div', { id: 'print-area' }); document.body.append(box); }
    const parser = new DOMParser();
    box.replaceChildren(h('div', { class: 'label-sheet' }, codes.map(c => {
      const svg = parser.parseFromString(L.barcodeSvg(c, { height: kind === 'bin' ? 70 : 56 }), 'image/svg+xml').documentElement;
      return h('div', { class: `label ${kind}` }, h('div', { class: 'big' }, c), document.importNode(svg, true),
        h('div', { class: 'small' }, kind === 'sku' ? 'SIC CYCLES · FANGS WAREHOUSE · first photo' : 'SIC CYCLES · BIN'));
    })));
    document.body.classList.add('printing');
    setTimeout(() => { window.print(); document.body.classList.remove('printing'); }, 150);
  }
  function viewLabels() {
    const num = (v, p) => h('input', { type: 'number', min: 1, max: 99, value: v, placeholder: p });
    const wh = h('input', { type: 'text', value: 'WH1' }), r1 = num(1), r2 = num(1), s1 = num(1), s2 = num(4), b1 = num(1), b2 = num(8);
    const locList = h('div', { class: 'grid-wrap' }, h('p', { class: 'empty' }, 'Loading…'));
    A.select('wh_locations', 'select=code,label,active&order=code').then(locs => {
      const count = groupBy(S.items.filter(i => i.location_code && !['shipped', 'installed', 'archived'].includes(i.status)), 'location_code');
      locList.replaceChildren(locs.length ? h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, 'Location'), h('th', {}, 'Items'))),
        h('tbody', {}, locs.map(l => h('tr', { onclick: () => { S.filter.q = l.code; S.tab = isReviewer() ? 'master' : 'mine'; render(); } }, h('td', { class: 'mono' }, l.code), h('td', {}, (count[l.code] || []).length))))) : h('p', { class: 'empty' }, 'No locations yet.'));
    }).catch(err);
    const needCards = S.items.filter(i => i.created_by === S.me.user_id && !['published', 'sold', 'shipped', 'installed', 'archived'].includes(i.status) &&
      !(S.media[i.id] || []).some(m => m.slot === 'sku_card' && !m.hidden));
    return h('section', { class: 'stack' },
      h('div', { class: 'card' }, h('h2', {}, 'SKU cards'), h('p', { class: 'hint' }, 'Print a card, set it next to the part, and make it the first photo.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', disabled: !needCards.length, onclick: () => printLabels(needCards.map(i => i.sku), 'sku') }, `Print cards for my ${needCards.length} parts without a SKU-card photo`),
          has('intake') ? h('button', { class: 'btn', onclick: async () => {
            const n = Number(prompt('How many new parts (blank drafts with SKUs) to create and print cards for? (max 40)', '10'));
            if (!n || n < 1 || n > 40) return;
            const skus = [];
            try { for (let i = 0; i < n; i++) { const r = await A.rpc('wh_create_item', { p_fields: {} }); skus.push(r.item.sku); } } catch (e) { err(e); }
            await loadItems(); if (skus.length) printLabels(skus, 'sku');
          } }, 'Create blank parts + print cards') : null)),
      h('div', { class: 'card' }, h('h2', {}, 'Bin labels'), h('p', { class: 'hint' }, 'Creates the locations if they don’t exist, then prints a label per bin (max 200).'),
        h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Warehouse', wh), h('label', { class: 'field' }, 'Rows from', r1), h('label', { class: 'field' }, 'to', r2),
          h('label', { class: 'field' }, 'Shelves from', s1), h('label', { class: 'field' }, 'to', s2), h('label', { class: 'field' }, 'Bins from', b1), h('label', { class: 'field' }, 'to', b2)),
        h('button', { class: 'btn primary', onclick: async () => {
          const codes = [];
          for (let r = +r1.value; r <= +r2.value; r++) for (let s = +s1.value; s <= +s2.value; s++) for (let b = +b1.value; b <= +b2.value; b++) codes.push([r, s, b]);
          if (!codes.length || codes.length > 200) return flash('Choose between 1 and 200 bins.', 'err');
          const out = [];
          try { for (const [r, s, b] of codes) out.push(await A.rpc('wh_upsert_location', { p_warehouse: wh.value.trim().toUpperCase(), p_row: r, p_shelf: s, p_bin: b })); } catch (e) { return err(e); }
          printLabels(out, 'bin'); render();
        } }, 'Create & print bin labels')),
      h('div', { class: 'card' }, h('h2', {}, 'Locations'), locList));
  }

  /* ---------------- staff ---------------- */
  function viewStaff() {
    const ROLES = [['owner', 'Owner/Admin'], ['intake', 'Intake'], ['fitment_reviewer', 'Fitment reviewer'], ['listing_approver', 'Listing approver'], ['fulfillment', 'Fulfillment']];
    const rolesOf = id => S.roles.filter(r => r.user_id === id).map(r => r.role);
    const email = h('input', { type: 'email', placeholder: 'their RIDE account email' }), name = h('input', { type: 'text' }), active = h('input', { type: 'checkbox', checked: true });
    const boxes = ROLES.map(([k, l]) => h('label', { class: 'field check' }, h('input', { type: 'checkbox', value: k, checked: k === 'intake' }), l));
    return h('section', { class: 'stack' },
      h('div', { class: 'card' }, h('h2', {}, 'Staff'), h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['Name', 'Roles', 'Active'].map(t => h('th', {}, t)))),
        h('tbody', {}, S.staff.map(s => h('tr', { onclick: () => { name.value = s.display_name; active.checked = s.active; boxes.forEach(b => { b.firstChild.checked = rolesOf(s.user_id).includes(b.firstChild.value); }); flash('Enter their email to update them.'); } },
          h('td', {}, s.display_name), h('td', {}, rolesOf(s.user_id).join(', ')), h('td', {}, s.active ? 'Yes' : 'No'))))))),
      h('div', { class: 'card' }, h('h2', {}, 'Add or update staff'),
        h('p', { class: 'hint' }, 'The person must first create a normal RIDE account at ride.siccycles.com. Up to five people are expected.'),
        h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Email', email), h('label', { class: 'field' }, 'Display name', name), h('label', { class: 'field check' }, active, 'Active')),
        h('div', { class: 'fields' }, boxes),
        h('button', { class: 'btn primary', onclick: async () => {
          const roles = boxes.map(b => b.firstChild).filter(i => i.checked).map(i => i.value);
          if (!email.value || !name.value || !roles.length) return flash('Email, name and at least one role are required.', 'err');
          try { await A.rpc('wh_set_staff', { p_email: email.value, p_display_name: name.value, p_roles: roles, p_active: active.checked }); await loadRefs(); flash('Staff saved.'); render(); } catch (e) { err(e); }
        } }, 'Save staff member')));
  }

  /* ---------------- lifecycle ---------------- */
  let timersStarted = false;
  function startTimers() {
    if (timersStarted) return; timersStarted = true;
    ['pointerdown', 'keydown'].forEach(ev => addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true }));
    setInterval(async () => {
      if (!S.me) return;
      if (Date.now() - S.lastActivity > 30 * 60 * 1000) { await flushSave().catch(() => {}); await signOut(); flash('Signed out after 30 minutes without activity.'); return; }
      if (document.visibilityState === 'visible' && !S.ed && !$dialog.open && S.tab !== 'import') {
        try { await loadItems(); const f = document.activeElement; if (!f || f === document.body) render(); } catch { /* next time */ }
      }
    }, 60000);
    addEventListener('beforeunload', e => { if (S.ed && (Object.keys(S.ed.dirty).length || S.uploads.some(u => u.status !== 'done'))) { e.preventDefault(); e.returnValue = ''; } });
  }
  async function boot() {
    if (!A.readSession()?.access_token) return showSignIn();
    try { await A.verify(); } catch (e) { return showSignIn(e.status === 401 ? '' : e.message); }
    try {
      S.me = await A.rpc('wh_me', {});
      if (!S.me.staff) return showNoAccess();
      renderWho(); await loadRefs(); await loadItems();
      if (!has('intake') && isReviewer()) S.tab = 'queues';
      render(); startTimers();
    } catch (e) {
      $app.replaceChildren(h('div', { class: 'signin' }, h('h2', {}, 'Warehouse unavailable'), h('p', {}, e.message),
        h('p', { class: 'hint' }, e.status === 404 ? 'The warehouse database has not been installed yet.' : ''), h('button', { class: 'btn', onclick: boot }, 'Try again'), h('button', { class: 'btn', onclick: signOut }, 'Sign out')));
    }
  }
  boot();
})();
