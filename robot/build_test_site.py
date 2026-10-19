"""Builds the static site the Robot Framework tests run against.

It takes the real index.html and styles.css, removes the CDN scripts and the real Supabase config,
and injects robot/fixtures/mock-supabase.js instead. Output: robot/.site/
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROBOT = ROOT / 'robot'
OUT = ROBOT / '.site'

html = (ROOT / 'index.html').read_text(encoding='utf-8')

# Every external script must be found and replaced: otherwise the tests could silently hit real services.
patterns = {
    'chart.js CDN': r'[ \t]*<script src="https://cdn\.jsdelivr\.net/npm/chart\.js[^"]*"[^>]*></script>\r?\n',
    'supabase-js CDN': r'[ \t]*<script src="https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js[^"]*"[^>]*></script>\r?\n',
    'supabase-config.js': r'[ \t]*<script src="\./supabase-config\.js"></script>\r?\n',
}
for label, pattern in patterns.items():
    html, count = re.subn(pattern, '', html)
    if count != 1:
        sys.exit(f'build_test_site: expected exactly one "{label}" script tag in index.html, found {count}')

marker = '<link rel="stylesheet" href="./styles.css">'
if html.count(marker) != 1:
    sys.exit('build_test_site: stylesheet link not found in index.html')
html = html.replace(marker, marker + '\n    <script src="./mock-supabase.js"></script>')

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir(parents=True)

(OUT / 'index.html').write_text(html, encoding='utf-8')
shutil.copy(ROOT / 'styles.css', OUT / 'styles.css')
shutil.copy(ROOT / 'favicon.ico', OUT / 'favicon.ico')
shutil.copy(ROBOT / 'fixtures' / 'mock-supabase.js', OUT / 'mock-supabase.js')
shutil.copy(ROBOT / 'fixtures' / 'narrow.html', OUT / 'narrow.html')

print(f'Test site built in {OUT}')
