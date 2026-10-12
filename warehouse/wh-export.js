/* Fangs Warehouse exports: Shopify product CSV (always Draft), master/worker spreadsheets
   (XLSX and CSV) and reports. Pure functions, no network, no dependencies, so they run the
   same in the browser and in `node --test`.
   The database stays the master record; every file made here is a snapshot. */
(function (root) {
  'use strict';

  const CONDITION = {
    new_nos: 'New old stock', excellent: 'Excellent used', good: 'Good used',
    fair: 'Fair used (see defects)', core_parts: 'Core / for parts or rebuild',
  };
  const TESTED = {
    tested_working: 'Tested working', untested: 'Untested', known_issue: 'Known issue (see notes)',
    not_applicable: 'Not applicable',
  };
  const FITMENT_STATUS = {
    verified_exact: 'Verified exact fit', verified_conditions: 'Verified fit with conditions',
    probable: 'Probable fit (confirm before buying)', universal: 'Universal / fits by measurement',
    unknown: 'Unknown',
  };

  // Text that starts with = + - @ (or tab/CR) is run as a formula by Excel. Neutralize it.
  function safeText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const s = String(value);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  function csv(rows, headers) {
    const cell = v => {
      const s = safeText(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.map(cell).join(',')];
    for (const r of rows) lines.push(headers.map(h => cell(r[h])).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';  // BOM so Excel reads UTF-8
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function yearRange(f) {
    if (f.start_year && f.end_year) return f.start_year === f.end_year ? String(f.start_year) : `${f.start_year}-${f.end_year}`;
    return f.start_year ? `${f.start_year}+` : (f.end_year ? `up to ${f.end_year}` : '');
  }

  function fitmentLine(f, families) {
    return [f.make, families[f.engine_family] || f.engine_family, f.platform, f.model_codes, yearRange(f)]
      .filter(Boolean).join(' ');
  }

  // Stable Shopify handle. Never built from the title, so a title edit can't create a duplicate.
  function handleFor(sku) { return String(sku).toLowerCase(); }

  const isListingImage = m => (m.bucket === 'wh-marketplace' || m.bucket === 'external') && !m.hidden;
  function publicImageUrl(baseUrl, media) {
    if (media.bucket === 'external') return media.path;  // seller's existing eBay photo
    return `${baseUrl.replace(/\/$/, '')}/storage/v1/object/public/${media.bucket}/${media.path.split('/').map(encodeURIComponent).join('/')}`;
  }

  function descriptionHtml(item, fitments, lookups) {
    const parts = [];
    if (item.description) parts.push(`<p>${escapeHtml(item.description).replace(/\n/g, '<br>')}</p>`);
    const facts = [
      ['SIC SKU', item.sku],
      ['Brand', item.brand],
      ['OEM / aftermarket', item.oem_aftermarket === 'oem' ? 'OEM' : item.oem_aftermarket === 'aftermarket' ? 'Aftermarket' : ''],
      ['Part number', item.oem_part_number],
      ['Casting / stamped numbers', (item.casting_numbers || []).join(', ')],
      ['Condition', CONDITION[item.condition_grade]],
      ['Condition notes', item.condition_notes],
      ['Tested', TESTED[item.tested_status]],
      ['Material', item.material],
      ['Color / finish', item.color],
      ['Size (L × W × H)', item.bare_length_in ? `${item.bare_length_in} × ${item.bare_width_in} × ${item.bare_height_in} in` : ''],
    ].filter(([, v]) => v);
    parts.push('<ul>' + facts.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</li>`).join('') + '</ul>');
    parts.push(`<p><strong>Fitment:</strong> ${escapeHtml(FITMENT_STATUS[item.fitment_status] || '')}</p>`);
    if (fitments.length) {
      parts.push('<ul>' + fitments.map(f => {
        const extra = [f.conditions && `Conditions: ${f.conditions}`, f.exclusions && `Does not fit: ${f.exclusions}`].filter(Boolean).join('. ');
        return `<li>${escapeHtml(fitmentLine(f, lookups.families))}${extra ? ` (${escapeHtml(extra)})` : ''}</li>`;
      }).join('') + '</ul>');
    }
    parts.push('<p>Used part, sold as described and pictured. Please confirm fitment against your part number before ordering. Questions? Contact SIC Cycles.</p>');
    return parts.join('\n');
  }

  function tagsFor(item, fitments, lookups) {
    const t = new Set(['sic-warehouse', 'used-parts']);
    if (item.condition_grade) t.add(`condition-${item.condition_grade.replace(/_/g, '-')}`);
    if (lookups.systems[item.system_code]) t.add(lookups.systems[item.system_code]);
    for (const f of fitments) {
      if (f.engine_family && lookups.families[f.engine_family]) t.add(lookups.families[f.engine_family]);
      if (f.platform) t.add(f.platform);
      if (f.make) t.add(f.make);
      const y = yearRange(f); if (y) t.add(y);
    }
    return [...t].map(x => x.replace(/,/g, ' ')).join(', ');
  }

  const SHOPIFY_HEADERS = ['Title', 'URL handle', 'Description', 'Vendor', 'Type', 'Tags', 'Published on online store',
    'Status', 'SKU', 'Option1 name', 'Option1 value', 'Price', 'Charge tax', 'Inventory tracker', 'Inventory quantity',
    'Continue selling when out of stock', 'Weight value (grams)', 'Weight unit for display', 'Requires shipping',
    'Fulfillment service', 'Product image URL', 'Image position', 'Image alt text', 'SEO title', 'SEO description'];

  const EXPORTABLE = new Set(['ready_to_publish', 'published']);

  /* items: wh_items rows. fitmentsByItem / mediaByItem: {itemId: [...]}. lookups: {systems, families}.
     Returns {csv, rows, skipped} — skipped lists items refused and why. */
  function shopifyCsv(items, fitmentsByItem, mediaByItem, lookups, baseUrl) {
    const rows = [], skipped = [];
    for (const item of items) {
      if (!EXPORTABLE.has(item.status)) { skipped.push({ sku: item.sku, reason: `status is ${item.status}` }); continue; }
      const images = (mediaByItem[item.id] || []).filter(isListingImage)
        .sort((a, b) => (a.bucket === 'external') - (b.bucket === 'external') || a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
      if (!images.length) { skipped.push({ sku: item.sku, reason: 'no marketplace image' }); continue; }
      const fits = fitmentsByItem[item.id] || [];
      const grams = item.weight_oz ? Math.round(Number(item.weight_oz) * 28.3495) : '';
      const title = String(item.title).slice(0, 255);
      const handle = handleFor(item.sku);
      const seoDesc = [CONDITION[item.condition_grade], fits.slice(0, 3).map(f => fitmentLine(f, lookups.families)).join('; '), item.oem_part_number && `PN ${item.oem_part_number}`]
        .filter(Boolean).join('. ').slice(0, 320);
      images.forEach((img, i) => {
        const base = { 'URL handle': handle, 'Product image URL': publicImageUrl(baseUrl, img), 'Image position': i + 1,
          'Image alt text': `${title} - ${img.slot.replace(/_/g, ' ')}`.slice(0, 512) };
        if (i === 0) Object.assign(base, {
          Title: title, Description: descriptionHtml(item, fits, lookups), Vendor: item.brand || 'SIC Cycles',
          Type: lookups.systems[item.system_code] || '', Tags: tagsFor(item, fits, lookups),
          'Published on online store': 'TRUE', Status: 'draft', SKU: item.sku, 'Option1 name': 'Title',
          'Option1 value': 'Default Title', Price: Number(item.asking_price).toFixed(2), 'Charge tax': 'TRUE',
          'Inventory tracker': 'shopify', 'Inventory quantity': item.quantity,
          'Continue selling when out of stock': 'FALSE', 'Weight value (grams)': grams, 'Weight unit for display': 'lb',
          'Requires shipping': item.local_pickup_only ? 'FALSE' : 'TRUE', 'Fulfillment service': 'manual',
          'SEO title': `${title} | SIC Cycles`.slice(0, 70), 'SEO description': seoDesc,
        });
        rows.push(base);
      });
    }
    return { csv: csv(rows, SHOPIFY_HEADERS), rows, skipped, headers: SHOPIFY_HEADERS };
  }

  // Master / worker sheet: one row per item, image links (not image files), fitment summary.
  const SHEET_COLUMNS = [
    ['SKU', i => i.sku], ['Status', i => i.status], ['Title', i => i.title], ['Brand', i => i.brand],
    ['OEM/Aftermarket', i => i.oem_aftermarket], ['OEM part #', i => i.oem_part_number],
    ['Casting #s', i => (i.casting_numbers || []).join(' | ')], ['System', (i, x) => x.lookups.systems[i.system_code] || i.system_code],
    ['Fitment status', i => i.fitment_status], ['Fitment evidence', i => i.fitment_evidence_level],
    ['Evidence source', i => i.fitment_evidence_source],
    ['Fitment', (i, x) => (x.fitmentsByItem[i.id] || []).map(f => fitmentLine(f, x.lookups.families)).join(' | ')],
    ['Condition', i => i.condition_grade], ['Condition notes', i => i.condition_notes], ['Tested', i => i.tested_status],
    ['Color', i => i.color], ['Material', i => i.material], ['Qty', i => i.quantity],
    ['Bare L in', i => num(i.bare_length_in)], ['Bare W in', i => num(i.bare_width_in)], ['Bare H in', i => num(i.bare_height_in)],
    ['Packed L in', i => num(i.packed_length_in)], ['Packed W in', i => num(i.packed_width_in)], ['Packed H in', i => num(i.packed_height_in)],
    ['Weight oz', i => num(i.weight_oz)], ['Weight source', i => i.weight_source], ['Shipping class', i => i.shipping_class],
    ['Oversize', i => i.is_oversize], ['Hazmat', i => i.is_hazmat], ['Local pickup only', i => i.local_pickup_only],
    ['Location', i => i.location_code], ['Asking price', i => num(i.asking_price)],
    ['Image URLs', (i, x) => (x.mediaByItem[i.id] || []).filter(isListingImage).map(m => publicImageUrl(x.baseUrl, m)).join(' ')],
    ['Created by', (i, x) => x.names[i.created_by] || i.created_by], ['Created at', i => i.created_at],
    ['Last edited by', (i, x) => x.names[i.updated_by] || i.updated_by || ''], ['Last edited at', i => i.updated_at],
    ['Fitment verified by', (i, x) => x.names[i.fitment_verified_by] || ''], ['Condition graded by', (i, x) => x.names[i.condition_graded_by] || ''],
    ['Listing approved by', (i, x) => x.names[i.listing_approved_by] || ''], ['Published by', (i, x) => x.names[i.published_by] || ''],
    ['Picked by', (i, x) => x.names[i.picked_by] || ''], ['Packed by', (i, x) => x.names[i.packed_by] || ''],
    ['Shopify product id', i => i.shopify_product_id], ['eBay item id', i => i.ebay_item_id],
  ];
  const FINANCIAL_COLUMNS = [
    ['Cost', (i, x) => num(x.financials[i.id]?.cost)], ['Consignor', (i, x) => x.financials[i.id]?.consignor],
    ['Min approved price', (i, x) => num(x.financials[i.id]?.min_approved_price)],
  ];
  function num(v) { return v === null || v === undefined || v === '' ? '' : Number(v); }

  function itemTable(items, ctx) {
    const cols = SHEET_COLUMNS.concat(ctx.financials ? FINANCIAL_COLUMNS : []);
    const headers = cols.map(c => c[0]);
    const x = { fitmentsByItem: {}, mediaByItem: {}, names: {}, baseUrl: '', ...ctx };
    const rows = items.map(i => Object.fromEntries(cols.map(([h, f]) => { const v = f(i, x); return [h, v ?? '']; })));
    return { headers, rows };
  }

  /* ---------- minimal XLSX writer (stored zip, inline strings) ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const enc = s => new TextEncoder().encode(s);

  function zip(files) {  // files: [{name, data: Uint8Array}]
    const chunks = [], central = []; let offset = 0;
    const u16 = v => [v & 0xFF, (v >>> 8) & 0xFF], u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
    for (const f of files) {
      const name = enc(f.name), crc = crc32(f.data), size = f.data.length;
      const local = Uint8Array.from([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
        ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)]);
      chunks.push(local, name, f.data);
      central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
        ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += local.length + name.length + size;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(cdSize), ...u32(offset), ...u16(0)]);
    const all = [...chunks, ...central, end], out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
    let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  function colName(n) { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

  function sheetXml(headers, rows) {
    const cellXml = (v, ref, bold) => {
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
      const s = safeText(v); if (s === '') return '';
      return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(s.slice(0, 32767))}</t></is></c>`;
    };
    const lines = [`<row r="1">${headers.map((h, c) => cellXml(h, colName(c) + 1, true)).join('')}</row>`];
    rows.forEach((r, i) => lines.push(`<row r="${i + 2}">${headers.map((h, c) => cellXml(r[h], colName(c) + (i + 2))).join('')}</row>`));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${lines.join('')}</sheetData></worksheet>`;
  }

  /* sheets: [{name, headers, rows}] -> Uint8Array .xlsx */
  function xlsx(sheets) {
    const safeName = (n, i) => (String(n).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);
    const files = [
      { name: '[Content_Types].xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`) },
      { name: '_rels/.rels', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
      { name: 'xl/workbook.xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
      { name: 'xl/styles.xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`) },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(sheetXml(s.headers, s.rows)) })),
    ];
    return zip(files);
  }

  async function sha256Hex(data) {
    const bytes = typeof data === 'string' ? enc(data) : data;
    const c = (root.crypto && root.crypto.subtle) || (typeof require === 'function' ? require('node:crypto').webcrypto.subtle : null);
    const h = await c.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  root.WhExport = { safeText, csv, shopifyCsv, SHOPIFY_HEADERS, itemTable, xlsx, zip, crc32, sha256Hex, handleFor,
    publicImageUrl, isListingImage, descriptionHtml, fitmentLine, CONDITION, TESTED, FITMENT_STATUS };
})(typeof window !== 'undefined' ? window : globalThis);
