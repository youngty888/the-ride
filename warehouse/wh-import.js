/* Fangs Warehouse: read an eBay Seller Hub "active listings" report (CSV) into import rows.
   Header names vary between eBay report versions, so columns are found by name patterns.
   Everything parsed from a title (part number, engine family, category) is a HINT for the
   reviewer, never a fitment claim. */
(function (root) {
  'use strict';

  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    const s = String(text).replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(v => v.trim() !== ''));
  }

  const norm = h => String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const FIELDS = {
    ebay_item_id: [/^item (number|id)$/, /^itemid$/, /^item no$/],
    title: [/^title$/, /^item title$/],
    price: [/^current price$/, /^start price$/, /^price$/, /^buy it now price$/],
    quantity: [/^available quantity$/, /^quantity available$/, /^quantity$/],
    condition: [/^condition$/, /^condition name$/, /^item condition$/],
    category: [/^ebay category 1 name$/, /^category name$/, /^category$/, /^store category$/],
    custom_label: [/^custom label sku$/, /^custom label$/, /^sku$/],
    image_urls: [/^pic ?url$/, /^picture urls?$/, /^image urls?$/, /^item photo urls?$/, /^photo urls?$/],
  };

  // eBay photo links, upgraded to the largest size eBay serves. Only i.ebayimg.com is accepted.
  function imageUrls(cell) {
    return String(cell || '').split(/[|,\s]+/).map(u => u.trim())
      .filter(u => /^https:\/\/i\.ebayimg\.com\/[A-Za-z0-9/_.~%-]+$/.test(u))
      .map(u => u.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, '/s-l1600.$1'))
      .filter((u, i, a) => a.indexOf(u) === i).slice(0, 24);
  }

  // Finds the header row (eBay sometimes puts notes above it) and maps columns.
  function mapHeaders(rows) {
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const names = rows[r].map(norm), map = {};
      for (const [field, pats] of Object.entries(FIELDS)) {
        for (const p of pats) { const i = names.findIndex(n => p.test(n)); if (i >= 0) { map[field] = i; break; } }
      }
      if (map.ebay_item_id !== undefined && map.title !== undefined) return { headerRow: r, map };
    }
    return null;
  }

  // Harley part numbers look like 25266-93B, 17540-84, 61400035 (8-digit newer). Honda 33655-GS7-671, Kawasaki 92049-0058.
  const PN_PATTERNS = [
    /\b\d{5}-\d{2}[A-Z]{0,2}\b/,
    /\b\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3}\b/,
    /\b\d{5}-\d{4}\b/,
    /\b\d{8}\b/,
  ];
  function partNumber(title) {
    for (const p of PN_PATTERNS) { const m = String(title).toUpperCase().match(p); if (m) return m[0]; }
    return '';
  }

  const FAMILY_WORDS = [
    ['milwaukee_eight', /\b(m8|milwaukee[- ]?eight|2017\+|17-2\d)\b/i],
    ['twin_cam_88', /\b(twin ?cam|tc88|tc ?96|tc ?103|tc ?110)\b/i],
    ['evo_sportster', /\b(sportster|xl ?883|xl ?1200|883|1200xl)\b/i],
    ['evolution', /\b(evo|evolution)\b/i],
    ['shovelhead', /\bshovel(head)?\b/i],
    ['panhead', /\bpan ?head\b/i],
    ['knucklehead', /\bknuckle ?head\b/i],
    ['ironhead', /\biron ?head\b/i],
    ['revolution', /\b(v-?rod|vrsc|revolution)\b/i],
    ['japanese', /\b(honda|kawasaki|suzuki|yamaha)\b/i],
  ];
  const SYSTEM_WORDS = [
    ['exhaust', /\b(exhaust|muffler|header|head ?pipe|slip-?on)\b/i],
    ['brakes', /\b(brake|caliper|rotor|master cylinder|pads?)\b/i],
    ['wheels_tires', /\b(wheel|rim|hub|spoke|tire|axle)\b/i],
    ['fuel_intake', /\b(carb|carburetor|air cleaner|intake|petcock|fuel pump|throttle body|injector)\b/i],
    ['transmission', /\b(transmission|tranny|trans cover|shifter drum|gearbox|kicker)\b/i],
    ['primary_drivetrain', /\b(primary|clutch|pulley|sprocket|belt|chain|compensator)\b/i],
    ['electrical_ignition', /\b(ignition|switch|wiring|harness|starter|regulator|stator|voes|sensor|coil|battery)\b/i],
    ['front_suspension', /\b(fork|triple tree|front end|steering|risers?)\b/i],
    ['rear_suspension', /\b(shock|swingarm|air ride|strut)\b/i],
    ['lighting', /\b(light|lamp|lens|signal|blinker|headlight|taillight)\b/i],
    ['controls', /\b(lever|pedal|peg|floorboard|forward control|grip|handlebar|cable|throttle)\b/i],
    ['tanks_bodywork', /\b(tank|fender|fairing|side cover|cover panel|dash|emblem|badge|derby)\b/i],
    ['seats_luggage', /\b(seat|saddlebag|tour ?pak|backrest|sissy|rack|luggage)\b/i],
    ['frame_chassis', /\b(frame|kickstand|jiffy|stand|crash bar|engine guard|bracket|mount)\b/i],
    ['engine', /\b(cylinder|head|rocker|cam|piston|pushrod|lifter|tappet|crank|oil pump|gasket|valve|engine|motor|case)\b/i],
    ['hardware_misc', /\b(bolt|screw|nut|washer|hardware|seal)\b/i],
  ];
  const MOTO_WORDS = /\b(harley|hd|h-d|davidson|buell|indian|honda|kawasaki|suzuki|yamaha|ducati|triumph|ktm|bmw r|husqvarna|big dog|shovelhead|panhead|evo|twin cam|sportster|softail|dyna|touring|road king|road glide|street glide|v-?rod|flh|fxr|fx|motorcycle|atv|pwc)\b/i;
  const NOT_MOTO = /\b(audi|corvette|chevy|chevrolet|tea set|kutani|dragon ?ware|porcelain|jet ?ski|snowmobile|car|truck)\b/i;

  function hints(title, category) {
    const t = `${title} ${category || ''}`;
    const fam = FAMILY_WORDS.find(([, re]) => re.test(t));
    const sys = SYSTEM_WORDS.find(([, re]) => re.test(title));
    const years = String(title).match(/\b(19[3-9]\d|20[0-3]\d)\s*[-–]\s*(19[3-9]\d|20[0-3]\d|\d{2})\b|\b'?(\d{2})\s*[-–]\s*'?(\d{2})\b/);
    return {
      source: 'title_parse', part_number: partNumber(title) || null, engine_family: fam ? fam[0] : null,
      system_code: sys ? sys[0] : null, years: years ? years[0] : null,
      looks_like_motorcycle: MOTO_WORDS.test(t) && !(NOT_MOTO.test(t) && !/\b(harley|hd|honda|kawasaki|yamaha|suzuki|ducati)\b/i.test(t)),
    };
  }

  /* text -> {rows: [{ebay_item_id,title,price,quantity,condition,category,part_number,system_code,hints,include}], error} */
  function ebayRows(text) {
    const table = parseCsv(text);
    const found = mapHeaders(table);
    if (!found) return { rows: [], error: 'Could not find "Item number" and "Title" columns. Use the Seller Hub active listings report (CSV).' };
    const { headerRow, map } = found, rows = [];
    for (const r of table.slice(headerRow + 1)) {
      const get = f => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim());
      const title = get('title'), id = get('ebay_item_id').replace(/[^0-9]/g, '');
      if (!title && !id) continue;
      const price = get('price').replace(/[^0-9.]/g, '');
      const h = hints(title, get('category'));
      rows.push({ ebay_item_id: id, title, price, quantity: get('quantity').replace(/[^0-9]/g, '') || '1',
        condition: get('condition'), category: get('category'), custom_label: get('custom_label'),
        part_number: h.part_number || '', system_code: h.system_code || '', hints: h, include: h.looks_like_motorcycle,
        image_urls: imageUrls(get('image_urls')) });
    }
    return { rows, error: null };
  }

  root.WhImport = { parseCsv, ebayRows, hints, partNumber, imageUrls };
})(typeof window !== 'undefined' ? window : globalThis);
