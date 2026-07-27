// Aggregates the two Google Sheet CSV exports (tabs "Target CAC" and "Dati Meta")
// into the two compact arrays the dashboard template needs.
// Run: node aggregate.js <target_cac.csv> <dati_meta.csv> <out_dir>
const fs = require('fs');

const targetCacPath = process.argv[2];
const datiMetaPath = process.argv[3];
const outDir = process.argv[4];

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseEUR(s) {
  s = (s || '').trim().replace('€', '').replace(/\s/g, '');
  return s ? parseFloat(s) : null;
}
function parsePct(s) {
  s = (s || '').trim().replace('%', '');
  return s ? parseFloat(s) : null;
}

// --- "Target CAC" tab: product list (column A) + budget/target metadata ---
const tcRows = parseCSV(fs.readFileSync(targetCacPath, 'utf8'));
const productsMeta = [];
const keyToFriendly = {};
for (let i = 1; i < tcRows.length; i++) {
  const r = tcRows[i];
  if (!r || !r[0]) continue;
  const name = r[0].trim();
  if (!name || name === 'TOT') continue;
  const key = (r[4] || '').trim();
  const isNew = name.indexOf('(NEW)') !== -1;
  const display = name.replace(' (NEW)', '').trim();
  const entry = {
    name: display,
    rawName: name,
    key: key || null,
    isNew: isNew,
    budgetPct: parsePct(r[1]),
    budgetMeta: parseEUR(r[2]),
    targetCAC: parseEUR(r[3])
  };
  productsMeta.push(entry);
  if (key) keyToFriendly[key] = display;
}
if (!productsMeta.length) throw new Error('No products parsed from Target CAC sheet — header/column layout may have changed.');

// --- "Dati Meta" tab: campaigns by day/country/product ---
// header: Ad Name, Country, Date, Amount Spent, Purchases, Products, Date2
const dmRows = parseCSV(fs.readFileSync(datiMetaPath, 'utf8'));
const expectedHeader = ['Ad Name', 'Country', 'Date', 'Amount Spent', 'Purchases', 'Products'];
const header = dmRows[0] || [];
for (let i = 0; i < expectedHeader.length; i++) {
  if ((header[i] || '').trim() !== expectedHeader[i]) {
    throw new Error('Dati Meta header mismatch at column ' + i + ': expected "' + expectedHeader[i] + '", got "' + header[i] + '"');
  }
}

const agg = new Map();
for (let i = 1; i < dmRows.length; i++) {
  const r = dmRows[i];
  if (!r || r.length < 6) continue;
  const country = (r[1] || '').trim() || 'unknown';
  const dateStr = (r[2] || '').trim();
  const parts = dateStr.split('/');
  if (parts.length !== 3) continue;
  const mm = parts[0].padStart(2, '0'), dd = parts[1].padStart(2, '0'), yyyy = parts[2];
  const iso = yyyy + '-' + mm + '-' + dd;
  const spend = parseFloat((r[3] || '0').replace('€', '')) || 0;
  const purchases = parseFloat(r[4] || '0') || 0;
  const key = (r[5] || '').trim();
  const friendly = keyToFriendly[key] || key;

  const k = iso + '|' + friendly + '|' + country;
  let e = agg.get(k);
  if (!e) { e = [iso, friendly, country, 0, 0]; agg.set(k, e); }
  e[3] += spend;
  e[4] += purchases;
}
if (!agg.size) throw new Error('No rows parsed from Dati Meta sheet.');

const daily = Array.from(agg.values()).sort(function (a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
});
daily.forEach(function (e) { e[3] = Math.round(e[3] * 100) / 100; });

fs.writeFileSync(outDir + '/productsMeta.json', JSON.stringify(productsMeta));
fs.writeFileSync(outDir + '/daily.json', JSON.stringify(daily));

console.log('productsMeta:', productsMeta.length, 'products');
console.log('daily rows:', daily.length);
console.log('date range:', daily[0][0], '->', daily[daily.length - 1][0]);
