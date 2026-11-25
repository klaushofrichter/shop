#!/usr/bin/env bash
# Build the shop's Kubernetes Secrets from named keys in the node's .env
# (docs/design/11 §1). Never the whole file, never a value on screen: it prints
# key names, and the Stripe key's prefix so the mode can be checked by eye.
#
#   scripts/create-secrets.sh --test [--env-file /path/.env] [--namespace shop] [--dry-run]
#   SHOP_MODE=live scripts/create-secrets.sh --live ...
#
# Secrets:
#   shop-env         the app's keys (the mode's Printful token and Stripe key,
#                    webhook secrets, Google sign-in, cookie and status-link
#                    secrets, SES, preview key)
#   shop-litestream  the backup bucket's key pair only (never in the app pod)
#
# --dry-run writes nothing to the cluster and prints the key names it would set.
set -euo pipefail
umask 077

mode=""
env_file="${SHOP_ENV_FILE:-.env}"
namespace="shop"
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --test) mode="test" ;;
    --live) mode="live" ;;
    --env-file) env_file="$2"; shift ;;
    --namespace) namespace="$2"; shift ;;
    --dry-run) dry_run=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$mode" ] || { echo "choose --test or --live" >&2; exit 2; }
if [ "$mode" = live ] && [ "${SHOP_MODE:-}" != live ]; then
  echo "--live needs SHOP_MODE=live as well: the live keys go only to a live deployment (ADR-0029)" >&2
  exit 2
fi
[ -r "$env_file" ] || { echo "cannot read $env_file" >&2; exit 2; }

# Read one key's value without sourcing the file (no shell expansion of values).
value_of() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
missing=()

# app_key <app variable> <.env key> [optional]
put() {
  local file="$1" app="$2" key="$3" optional="${4:-}" v
  v="$(value_of "$key")"
  if [ -z "$v" ]; then
    if [ -n "$optional" ]; then echo "  (skipped, not in .env yet) $app <- $key"; return; fi
    missing+=("$key")
    return
  fi
  printf '%s=%s\n' "$app" "$v" >> "$file"
  echo "  $app <- $key"
}

app="$tmp/shop-env"
backup="$tmp/shop-litestream"
: > "$app"; : > "$backup"

echo "shop-env ($mode):"
if [ "$mode" = test ]; then
  put "$app" PRINTFUL_TOKEN PRINTFUL_TOKEN_TEST
  put "$app" STRIPE_SECRET_KEY STRIPE_TEST_TOKEN
  put "$app" STRIPE_WEBHOOK_SECRET STRIPE_TEST_WEBHOOK_SECRET optional
  put "$app" PRINTFUL_WEBHOOK_SECRET PRINTFUL_TEST_WEBHOOK_SECRET optional
  put "$app" PRINTFUL_WEBHOOK_PUBLIC_KEY PRINTFUL_TEST_WEBHOOK_PUBLIC_KEY optional
else
  put "$app" PRINTFUL_TOKEN PRINTFUL_TOKEN
  put "$app" STRIPE_SECRET_KEY STRIPE_LIVE_TOKEN
  put "$app" STRIPE_WEBHOOK_SECRET STRIPE_LIVE_WEBHOOK_SECRET
  put "$app" PRINTFUL_WEBHOOK_SECRET PRINTFUL_LIVE_WEBHOOK_SECRET
  put "$app" PRINTFUL_WEBHOOK_PUBLIC_KEY PRINTFUL_LIVE_WEBHOOK_PUBLIC_KEY
fi
for k in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI ALLOWED_EMAILS COOKIE_SECRET STATUS_TOKEN_SECRET PREVIEW_KEY \
         SHOP_SES_AWS_ACCESS_KEY_ID SHOP_SES_AWS_SECRET_ACCESS_KEY; do
  put "$app" "$k" "$k"
done

echo "shop-litestream:"
put "$backup" LITESTREAM_ACCESS_KEY_ID SHOP_BACKUP_AWS_ACCESS_KEY_ID
put "$backup" LITESTREAM_SECRET_ACCESS_KEY SHOP_BACKUP_AWS_SECRET_ACCESS_KEY

if [ ${#missing[@]} -gt 0 ]; then
  echo "missing in $env_file: ${missing[*]}" >&2
  exit 1
fi

# The Stripe key must match the mode (the app refuses the wrong one too).
stripe="$(grep -E '^STRIPE_SECRET_KEY=' "$app" | cut -d= -f2-)"
want="rk_${mode}_"
case "$stripe" in
  "$want"*) echo "Stripe key prefix: $want" ;;
  *) echo "STRIPE_SECRET_KEY is not a restricted $mode key ($want...)" >&2; exit 1 ;;
esac

if [ "$dry_run" = 1 ]; then
  echo "dry run: nothing written to namespace $namespace"
  exit 0
fi
for s in shop-env shop-litestream; do
  kubectl -n "$namespace" create secret generic "$s" --from-env-file="$tmp/$s" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "applied secret/$s in namespace $namespace"
done
