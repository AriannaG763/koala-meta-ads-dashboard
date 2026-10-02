// Keeps an ad-level history of daily Meta Ads spend, purchases and link clicks per country, pulled
// straight from the Marketing API (replacing the PMA-fed "Dati Meta" sheet, which often refreshed
// hours late and is half-empty for minutes while PMA rewrites it).
// The history file is restored from the Actions cache; each run re-fetches only the last
// WINDOW_DAYS (Meta still revises recent purchases) to stay well inside the app's API rate limits.
// With no usable history it fetches everything since START_DATE, month by month, pausing whenever
// the app's insights usage gets high (the app has development-tier rate limits).
// Run: META_ACCESS_TOKEN=... node fetch_meta.js <history_json>
const fs = require('fs');

const [, , historyPath] = process.argv;
const TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT = 'act_184244048859015';
// Meta retires API versions about two years after release; bump this when calls fail with error #2635.
const API_VERSION = 'v26.0';
const START_DATE = '2026-01-01';
const WINDOW_DAYS = 28;
const MAX_USAGE_PCT = 60;

const TODAY_ROME = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

let usagePct = 0;

async function call(method, path, params) {
  const qs = new URLSearchParams(params);
  const url = `https://graph.facebook.com/${API_VERSION}/${path}` + (method === 'GET' ? '?' + qs : '');
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: method === 'GET' ? undefined : qs,
    });
    const usage = resp.headers.get('x-business-use-case-usage');
    if (usage) {
      try {
        const u = Object.values(JSON.parse(usage))[0][0];
        usagePct = Math.max(u.call_count || 0, u.total_cputime || 0, u.total_time || 0);
      } catch (e) { /* header format changed: keep the last known value */ }
    }
    const body = await resp.json();
    if (resp.ok) return body;
    // Meta's rate-limit error codes (app, user, page, hourly, ads-insights business use case).
    const rateLimited = body.error && [4, 17, 32, 613, 80000, 80004].includes(body.error.code);
    const retryable = resp.status >= 500 || resp.status === 429 || rateLimited;
    if (!retryable || attempt >= (rateLimited ? 15 : 3)) throw new Error(`Meta API ${resp.status}: ${JSON.stringify(body.error || body)}`);
    await sleep(rateLimited ? 60 * 1000 : attempt * 5000);
  }
}

async function waitForQuota() {
  // A tiny account-level call, just to read the current usage header.
  await call('GET', `${AD_ACCOUNT}/insights`, { fields: 'spend', date_preset: 'yesterday' });
  const started = Date.now();
  while (usagePct > MAX_USAGE_PCT) {
    if (Date.now() - started > 90 * 60 * 1000) throw new Error(`Meta API usage still at ${usagePct}% after 90 minutes`);
    console.log(`Meta API usage at ${usagePct}%, waiting a minute`);
    await sleep(60 * 1000);
    await call('GET', `${AD_ACCOUNT}/insights`, { fields: 'spend', date_preset: 'yesterday' });
  }
}

// Row: [date, ad name, country ('unknown' when Meta can't attribute it), spend, purchases, link clicks]
async function fetchRange(since, until) {
  await waitForQuota();
  // An async report job: ad-level x country x day is too big for synchronous requests. No spend filter:
  // zero-spend rows can still carry purchases Meta attributed to that day.
  const job = await call('POST', `${AD_ACCOUNT}/insights`, {
    level: 'ad',
    fields: 'ad_name,spend,actions',
    breakdowns: 'country',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
  });
  const started = Date.now();
  for (;;) {
    const st = await call('GET', job.report_run_id, { fields: 'async_status' });
    if (st.async_status === 'Job Completed') break;
    if (st.async_status === 'Job Failed' || st.async_status === 'Job Skipped') throw new Error('Meta report job ' + st.async_status);
    if (Date.now() - started > 20 * 60 * 1000) throw new Error('Meta report job still not done after 20 minutes');
    await sleep(5000);
  }
  const rows = [];
  const params = { limit: '500' };
  for (;;) {
    const page = await call('GET', `${job.report_run_id}/insights`, params);
    for (const r of page.data) {
      const acts = Object.fromEntries((r.actions || []).map((a) => [a.action_type, Number(a.value)]));
      const row = [r.date_start, r.ad_name, r.country, Number(r.spend), acts.omni_purchase || 0, acts.link_click || 0];
      if (row[3] || row[4] || row[5]) rows.push(row);
    }
    const after = page.paging && page.paging.cursors && page.paging.cursors.after;
    if (!page.paging || !page.paging.next || !after) break;
    params.after = after;
  }
  return rows;
}

async function main() {
  if (!TOKEN) throw new Error('META_ACCESS_TOKEN is not set');
  let history = [];
  if (fs.existsSync(historyPath)) {
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (e) { history = []; }
  }
  const histDates = history.map((r) => r[0]).sort();
  const usable = histDates.length > 0 && histDates[0] <= addDays(START_DATE, 7);
  const since = usable ? addDays(TODAY_ROME, -(WINDOW_DAYS - 1)) : START_DATE;

  // One chunk per calendar month, so a full fetch can pause between chunks to stay under the rate limit.
  const fresh = [];
  for (let from = since; from <= TODAY_ROME; ) {
    const nextMonth = addDays(from.slice(0, 7) + '-01', 32).slice(0, 7) + '-01';
    const to = addDays(nextMonth, -1) < TODAY_ROME ? addDays(nextMonth, -1) : TODAY_ROME;
    const rows = await fetchRange(from, to);
    console.log(`fetched ${from} -> ${to}: ${rows.length} rows (API usage ${usagePct}%)`);
    fresh.push(...rows);
    from = nextMonth;
  }
  if (fresh.length === 0) throw new Error(`Meta API returned no rows for ${since} -> ${TODAY_ROME}`);
  const merged = history.filter((r) => r[0] < since).concat(fresh);
  fs.writeFileSync(historyPath, JSON.stringify(merged));
  const dates = merged.map((r) => r[0]).sort();
  console.log(usable ? 'incremental' : 'full', 'fetch from', since, '-', fresh.length, 'fresh rows;',
    merged.length, 'rows total,', dates[0], '->', dates[dates.length - 1]);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
