#!/usr/bin/env bash
# Re-stamps index.html with a fresh version so riders' phones fetch the new
# JS/CSS instead of serving a cached copy. Run this before every push.
#
#   ./bump-version.sh && git add -A && git commit -m "..." && git push
#
set -euo pipefail
cd "$(dirname "$0")"
V=$(date -u +%Y%m%d%H%M)
python3 - "$V" <<'PY'
import sys, re
v = sys.argv[1]
p = 'index.html'
s = open(p, encoding='utf-8').read()
# replace any existing ?v=NNNN on local assets, or add one if missing
s = re.sub(r'(href|src)="([\w.-]+\.(?:css|js))(\?v=\d+)?"', lambda m: f'{m.group(1)}="{m.group(2)}?v={v}"', s)
# leave absolute/CDN URLs alone (they contain ://) — the regex above only
# matches bare filenames, so unpkg/leaflet is untouched
if 'name="app-version"' in s:
    s = re.sub(r'<meta name="app-version" content="\d+">', f'<meta name="app-version" content="{v}">', s)
else:
    s = s.replace('</head>', f'  <meta name="app-version" content="{v}">\n</head>', 1)
open(p, 'w', encoding='utf-8').write(s)
print('stamped version', v)
PY
