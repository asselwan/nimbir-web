#!/usr/bin/env bash
# One-command production smoke. Exits non-zero on any failure.
# prm_69fa7b87 v1 / prm_de66dd10 v1 (2026-11-10). Curl first; headless Chrome only for the console-error check.
#
# Product config (edit the block below, nothing else):
#   SMOKE_NAME   product name for the report line
#   SMOKE_BASE   landing URL, no trailing slash
#   SMOKE_MUST   '|'-separated strings that must appear in the landing HTML (case-insensitive)
#   SMOKE_ROUTE  main app route or API health path, e.g. /_stcore/health  ("" to skip)
#   SMOKE_ROUTE_MUST  regex the route body must match ("" = only status 200 + body is not the landing page)
# Env overrides: SMOKE_BASE=https://staging.example ./scripts/smoke.sh ; SMOKE_BROWSER=0 skips the Chrome console check.
set -u
SMOKE_NAME="Nimbir"
SMOKE_BASE="${SMOKE_BASE:-https://nimbir.com}"
SMOKE_MUST="Nimbir"
SMOKE_ROUTE="/sitemap.xml"
SMOKE_ROUTE_MUST="<urlset"

fails=0; T0=$(date +%s)
ok()   { echo "ok   $*"; }
bad()  { echo "FAIL $*"; fails=$((fails+1)); }
TMP=$(mktemp -d "${TMPDIR:-/dev/shm}/smoke.XXXXXX" 2>/dev/null || mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo "SMOKE $SMOKE_NAME $SMOKE_BASE $(date -u +%FT%TZ)"

# 1. landing page: HTTPS 200
code=$(curl -sL -m 25 -o "$TMP/landing.html" -w '%{http_code}' "$SMOKE_BASE/")
case "$SMOKE_BASE" in https://*) ;; *) bad "landing not https: $SMOKE_BASE";; esac
[ "$code" = 200 ] && ok "landing HTTPS 200" || bad "landing status $code"

# 2. key strings present
IFS='|' read -r -a musts <<< "$SMOKE_MUST"
for s in "${musts[@]}"; do
  [ -z "$s" ] && continue
  grep -qiF -- "$s" "$TMP/landing.html" && ok "string present: $s" || bad "string missing: $s"
done

# 3. main route / API health answers (and is not just the SPA landing fallback)
if [ -n "$SMOKE_ROUTE" ]; then
  rc=$(curl -sL -m 25 -o "$TMP/route.out" -w '%{http_code}' "$SMOKE_BASE$SMOKE_ROUTE")
  if [ "$rc" != 200 ]; then bad "route $SMOKE_ROUTE status $rc"
  elif [ -n "$SMOKE_ROUTE_MUST" ]; then
    grep -qiE -- "$SMOKE_ROUTE_MUST" "$TMP/route.out" && ok "route $SMOKE_ROUTE 200 matches /$SMOKE_ROUTE_MUST/" || bad "route $SMOKE_ROUTE 200 but body does not match /$SMOKE_ROUTE_MUST/"
  else
    cmp -s "$TMP/route.out" "$TMP/landing.html" && bad "route $SMOKE_ROUTE returned the landing page (fallback, not a real route)" || ok "route $SMOKE_ROUTE 200 distinct from landing"
  fi
fi

# 4. same-origin CSS/JS referenced by the landing page all load (broken asset = broken release)
n=0; broken=0
while IFS= read -r a; do
  [ -z "$a" ] && continue
  case "$a" in //*) url="https:$a";; http*) url="$a";; /*) url="$SMOKE_BASE$a";; *) url="$SMOKE_BASE/$a";; esac
  case "$url" in "$SMOKE_BASE"*) ;; *) continue;; esac
  n=$((n+1)); c=$(curl -sL -m 20 -o /dev/null -w '%{http_code}' "$url"); [ "$c" = 200 ] || { broken=$((broken+1)); echo "     asset $c $url"; }
done < <(grep -oiE '(src|href)="[^"#]+\.(js|mjs|css)(\?[^"]*)?"' "$TMP/landing.html" | sed -E 's/^[a-z]+="//; s/"$//' | sort -u | head -40)
[ "$broken" = 0 ] && ok "assets: $n same-origin js/css all 200" || bad "assets: $broken of $n broken"

# 5. no console errors on the landing page (headless Chrome, skipped if absent or SMOKE_BROWSER=0)
CHROME=$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)
if [ "${SMOKE_BROWSER:-1}" = 1 ] && [ -n "$CHROME" ]; then
  timeout 90 "$CHROME" --headless=new --no-sandbox --disable-gpu --user-data-dir="$TMP/chrome" --enable-logging=stderr --v=0 \
    --virtual-time-budget=8000 --dump-dom "$SMOKE_BASE/" >/dev/null 2>"$TMP/chrome.log"
  errs=$(grep -E 'CONSOLE.*(Uncaught|Failed to load|ERR_|is not defined|Cannot read|SyntaxError|TypeError|ReferenceError)|:ERROR:CONSOLE' "$TMP/chrome.log" | head -5)
  [ -z "$errs" ] && ok "no console errors on landing" || { bad "console errors on landing"; echo "$errs" | cut -c1-220; }
else
  echo "skip console-error check (no chrome or SMOKE_BROWSER=0)"
fi

echo "SMOKE $SMOKE_NAME fails=$fails elapsed=$(( $(date +%s)-T0 ))s"
[ "$fails" = 0 ] && { echo "SMOKE PASS"; exit 0; } || { echo "SMOKE FAIL"; exit 1; }
