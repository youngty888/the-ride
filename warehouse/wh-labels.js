/* Printable SKU cards and bin labels with Code 128 barcodes (readable by any USB/Bluetooth
   scanner and most phone scanner apps). No library: Code 128-B is drawn as SVG here. */
(function (root) {
  'use strict';
  // Code 128 bar patterns (values 0-106), widths of bar/space modules.
  const P = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212',
    '112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222',
    '321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113',
    '132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131',
    '213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224',
    '111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114',
    '413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131',
    '211412','211214','211232','2331112'];

  function code128B(text) {
    const s = String(text);
    if (!/^[\x20-\x7E]+$/.test(s)) throw new Error('Barcode text must be plain ASCII.');
    const codes = [104]; // Start B
    for (const ch of s) codes.push(ch.charCodeAt(0) - 32);
    let sum = 104; for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103, 106);
    return codes.map(c => P[c]).join('');
  }

  function barcodeSvg(text, { height = 60, module = 2, quiet = 10 } = {}) {
    const pattern = code128B(text);
    let x = quiet * module, rects = '';
    [...pattern].forEach((w, i) => {
      const width = Number(w) * module;
      if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${width}" height="${height}"/>`;
      x += width;
    });
    const total = x + quiet * module;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" width="${total}" height="${height}" role="img" aria-label="${esc(text)}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  root.WhLabels = { code128B, barcodeSvg };
})(typeof window !== 'undefined' ? window : globalThis);
