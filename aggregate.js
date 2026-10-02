// Aggregates the "Target CAC" and "Regole Prodotti" Google Sheet CSV exports plus the ad-level
// Meta Ads API history (from fetch_meta.js) into the two compact arrays the dashboard template needs.
// Run: node aggregate.js <target_cac.csv> <meta_history.json> <regole_prodotti.csv> <out_dir>
const fs = require('fs');

const targetCacPath = process.argv[2];
const metaHistoryPath = process.argv[3];
const rulesPath = process.argv[4];
const outDir = process.argv[5];

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

// --- "Regole Prodotti" tab: ordered (text contained in the ad name -> product key) rules,
// first match wins, case-sensitive; no match -> "Other". Maintained by hand in the sheet.
const ruleRows = parseCSV(fs.readFileSync(rulesPath, 'utf8'));
const rules = [];
for (let i = 1; i < ruleRows.length; i++) {
  const pattern = (ruleRows[i][0] || '').trim();
  const productKey = (ruleRows[i][1] || '').trim();
  if (pattern && productKey) rules.push([pattern, productKey]);
}
if (!rules.length) throw new Error('No rules parsed from Regole Prodotti sheet.');
function productKeyOf(adName) {
  for (const [pattern, productKey] of rules) {
    if (adName.indexOf(pattern) !== -1) return productKey;
  }
  return 'Other';
}

// --- Meta Ads API history: [date, ad name, country, spend, purchases, link clicks] per row ---
const agg = new Map();
for (const [iso, adName, country, spend, purchases, linkClicks] of JSON.parse(fs.readFileSync(metaHistoryPath, 'utf8'))) {
  const key = productKeyOf(adName);
  const friendly = keyToFriendly[key] || key;
  const k = iso + '|' + friendly + '|' + country;
  let e = agg.get(k);
  if (!e) { e = [iso, friendly, country, 0, 0, 0]; agg.set(k, e); }
  e[3] += spend;
  e[4] += purchases;
  e[5] += linkClicks;
}
if (!agg.size) throw new Error('No rows in the Meta Ads API history.');

const daily = Array.from(agg.values()).sort(function (a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
});
daily.forEach(function (e) { e[3] = Math.round(e[3] * 100) / 100; e[5] = Math.round(e[5]); });

fs.writeFileSync(outDir + '/productsMeta.json', JSON.stringify(productsMeta));
fs.writeFileSync(outDir + '/daily.json', JSON.stringify(daily));

console.log('productsMeta:', productsMeta.length, 'products');
console.log('daily rows:', daily.length);
console.log('date range:', daily[0][0], '->', daily[daily.length - 1][0]);
