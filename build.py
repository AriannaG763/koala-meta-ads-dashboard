import sys
from datetime import datetime
from zoneinfo import ZoneInfo

scratch = sys.argv[1]

with open(scratch + '/template_with_placeholders.html', 'r', encoding='utf-8') as f:
    tpl = f.read()

with open(scratch + '/productsMeta.json', 'r', encoding='utf-8') as f:
    products_meta = f.read()

with open(scratch + '/daily.json', 'r', encoding='utf-8') as f:
    daily = f.read()

MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
             'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']
now = datetime.now(ZoneInfo('Europe/Rome'))
gen_date = '%d %s %d, %02d:%02d %s' % (
    now.day, MONTHS_IT[now.month - 1], now.year, now.hour, now.minute, now.tzname())

assert tpl.count('__PRODUCTS_META_JSON__') == 1, tpl.count('__PRODUCTS_META_JSON__')
assert tpl.count('__DAILY_JSON__') == 1
assert tpl.count('__GEN_DATE__') == 1

out = tpl.replace('__PRODUCTS_META_JSON__', products_meta)
out = out.replace('__DAILY_JSON__', daily)
out = out.replace('__GEN_DATE__', gen_date)

with open(scratch + '/meta-ads-dashboard.html', 'w', encoding='utf-8') as f:
    f.write(out)

print('wrote', len(out), 'bytes')
