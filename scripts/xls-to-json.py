#!/usr/bin/env python3
"""Convert the site's Wineries-Napa-Valley.xls into data/source-list.json.

The spreadsheet is the authoritative source for addresses, towns, websites and
phone numbers; review pages rarely contain them. Columns (header on row 7):
Winery | Address | City | Website | Phone | NWP | App | Cave | Notes/Labels
  NWP  "X"      -> reviewed on napawineproject.com
  App  "Yes"    -> visits by appointment
       "No"     -> no appointment needed (walk-ins)
       "Private"-> not open to the public
Requires: pip install xlrd  (the file is legacy BIFF .xls)
"""
import json, re, sys, datetime
import xlrd

SRC = 'data/wineries-source.xls'
OUT = 'data/source-list.json'

CITY_FIX = {'Am. Canyon': 'American Canyon', 'SF': 'San Francisco'}

def phone(v):
    v = v.strip()
    if not v:
        return None
    digits = re.sub(r'\D', '', v)
    if len(digits) == 7:                       # sheet omits the local 707 area code
        return f'(707) {digits[:3]}-{digits[3:]}'
    if len(digits) == 10:
        return f'({digits[:3]}) {digits[3:6]}-{digits[6:]}'
    if len(digits) == 11 and digits[0] == '1':
        return f'({digits[1:4]}) {digits[4:7]}-{digits[7:]}'
    return v or None

def website(v):
    v = v.strip().rstrip('/')
    if not v:
        return None
    if not re.match(r'^https?://', v):
        v = 'https://' + v
    return v

def visiting(app):
    return {
        'yes': 'By appointment',
        'no': 'Walk-ins welcome',
        'private': 'Not open to the public',
    }.get(app.strip().lower())

wb = xlrd.open_workbook(SRC)
sh = wb.sheet_by_index(0)

header_row = None
for r in range(min(sh.nrows, 20)):
    if str(sh.cell_value(r, 0)).strip().lower() == 'winery':
        header_row = r
        break
if header_row is None:
    sys.exit('xls-to-json: header row not found — did the sheet layout change?')

rows = []
for r in range(header_row + 1, sh.nrows):
    v = [str(sh.cell_value(r, c)).strip() for c in range(sh.ncols)]
    name = v[0]
    if not name or name.lower().startswith('more info'):
        continue
    city = CITY_FIX.get(v[2], v[2]) or None
    rows.append({
        'name': name,
        'address': v[1] or None,
        'city': city,
        'website': website(v[3]),
        'phone': phone(v[4]),
        'reviewed': v[5].strip().lower() in ('x', 'nwp'),
        'visiting': visiting(v[6]),
        'cave': v[7].strip().lower() in ('yes', 'cave'),
        'notes': v[8] or None,
    })

with open(OUT, 'w') as f:
    json.dump({
        'source': 'https://www.napawineproject.com/Wineries-Napa-Valley.xls',
        'convertedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'count': len(rows),
        'wineries': rows,
    }, f, indent=2)

n_addr = sum(1 for x in rows if x['address'])
print(f'xls-to-json: {len(rows)} rows -> {OUT} '
      f'(addresses: {n_addr}, reviewed: {sum(1 for x in rows if x["reviewed"])}, '
      f'caves: {sum(1 for x in rows if x["cave"])})')
