#!/usr/bin/env bash
# Read-only Printful API probe for the shop design (docs/design.md §14).
# Reads the Printful token from .env without printing it, makes GET requests only,
# and prints non-secret facts: store, token scopes, print areas and DPI per product,
# prices, webhook configuration. Run on the node from the shop clone:
#   scripts/printful-probe.sh [path/to/.env] > printful-probe.json
# The token variable name defaults to PRINTFUL_TOKEN; override with TOKEN_VAR=NAME.
set -euo pipefail

ENV_FILE="${1:-.env}"
TOKEN_VAR="${TOKEN_VAR:-PRINTFUL_TOKEN}"
API="https://api.printful.com"

[ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE" >&2; exit 1; }
TOKEN="$( { grep -E "^${TOKEN_VAR}=" "$ENV_FILE" || true; } | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
[ -n "$TOKEN" ] || { echo "$TOKEN_VAR not found in $ENV_FILE (variables present: $( { grep -oE '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE" || true; } | tr -d = | tr '\n' ' '))" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CFG="$TMP/curl.cfg"; umask 077
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$CFG"   # keeps the token out of the process list

get() {  # get <name> <path>: saves body to $TMP/<name>.json, status to stderr
  local code
  code="$(curl -sS -K "$CFG" -o "$TMP/$1.json" -w '%{http_code}' "$API$2")"
  echo "GET $2 -> $code" >&2
}

get stores        "/v2/stores"
get scopes        "/v2/oauth-scopes"
get webhooks      "/v2/webhooks"
for p in 1 2 19 433 71 12; do
  get "styles_$p" "/v2/catalog-products/$p/mockup-styles"
  get "prices_$p" "/v2/catalog-products/$p/prices?selling_region_name=north_america&currency=USD"
  get "product_$p" "/v2/catalog-products/$p"
done

python3 -I - "$TMP" <<'PY'
import json, os, sys
d = sys.argv[1]
def load(n):
    try:
        o = json.load(open(os.path.join(d, n + ".json")))
    except Exception as e:
        return {"_error": str(e)}
    return o if isinstance(o, dict) else {"_error": "unexpected response", "body": o}
def data(n, kind):
    o = load(n)
    v = o.get("data")
    return v if isinstance(v, kind) else ({} if kind is dict else [])
def strip(o):  # drop anything that looks like a secret, just in case
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if not any(s in k.lower() for s in ("secret", "token", "key"))}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o
out = {"stores": strip(load("stores")), "scopes": strip(load("scopes")), "webhooks": strip(load("webhooks")), "products": {}}
for p in (1, 2, 19, 433, 71, 12):
    prod = data(f"product_{p}", dict)
    styles = data(f"styles_{p}", list)
    areas = []
    for s in styles if isinstance(styles, list) else []:
        areas.append({k: s.get(k) for k in ("placement", "display_name", "technique", "print_area_width", "print_area_height", "print_area_type", "dpi")})
    prices = data(f"prices_{p}", dict) or load(f"prices_{p}")
    out["products"][p] = {
        "name": prod.get("name"),
        "techniques": prod.get("techniques"),
        "placements": prod.get("placements"),
        "print_areas": areas,
        "styles_raw_first2": strip(styles[:2]),
        "prices_sample": strip(prices) if len(json.dumps(prices)) < 20000 else "(large; first variants only) " + json.dumps(strip(prices))[:20000],
    }
print(json.dumps(out, indent=1))
PY
