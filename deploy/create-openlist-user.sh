#!/bin/sh
set -eu
umask 077

OPENLIST_CONTAINER="${OPENLIST_CONTAINER:-openlist}"
OPENLIST_API="${OPENLIST_API:-http://127.0.0.1:5244}"
OPENLIST_USERNAME="${OPENLIST_USERNAME:-vidpick}"
OPENLIST_BASE_PATH="${OPENLIST_BASE_PATH:-/media}"
OPENLIST_PERMISSION="${OPENLIST_PERMISSION:-128}"
TOKEN_FILE="${TOKEN_FILE:-/etc/vidpick/openlist-token.env}"

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

admin_token="$(
  docker exec "$OPENLIST_CONTAINER" ./openlist admin token 2>/dev/null |
    tail -n 1 |
    awk '{print $NF}'
)"
if [ "${#admin_token}" -lt 20 ]; then
  echo "OpenList admin token is unavailable." >&2
  exit 1
fi
temporary_password="$(openssl rand -hex 32)"

OPENLIST_USERNAME="$OPENLIST_USERNAME" \
OPENLIST_BASE_PATH="$OPENLIST_BASE_PATH" \
OPENLIST_PERMISSION="$OPENLIST_PERMISSION" \
TEMPORARY_PASSWORD="$temporary_password" \
python3 -c '
import json, os
print(json.dumps({
  "username": os.environ["OPENLIST_USERNAME"],
  "password": os.environ["TEMPORARY_PASSWORD"],
  "base_path": os.environ["OPENLIST_BASE_PATH"],
  "role": 0,
  "permission": int(os.environ["OPENLIST_PERMISSION"]),
  "disabled": False,
  "sso_id": "",
}))
' > "$temporary_directory/create.json"

curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: $admin_token" \
  --header "Content-Type: application/json" \
  --data-binary "@$temporary_directory/create.json" \
  "$OPENLIST_API/api/admin/user/create" \
  > "$temporary_directory/create-response.json"

python3 -c '
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
if payload.get("code") != 200:
    raise SystemExit("OpenList service user was not created: " + str(payload.get("message", "unknown error")))
' "$temporary_directory/create-response.json"

OPENLIST_USERNAME="$OPENLIST_USERNAME" \
TEMPORARY_PASSWORD="$temporary_password" \
python3 -c '
import json, os
print(json.dumps({
  "username": os.environ["OPENLIST_USERNAME"],
  "password": os.environ["TEMPORARY_PASSWORD"],
}))
' > "$temporary_directory/login.json"

curl --fail --silent --show-error \
  --request POST \
  --header "Content-Type: application/json" \
  --data-binary "@$temporary_directory/login.json" \
  "$OPENLIST_API/api/auth/login" \
  > "$temporary_directory/login-response.json"

service_token="$(python3 -c '
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
if payload.get("code") != 200 or not payload.get("data", {}).get("token"):
    raise SystemExit("OpenList service user login failed")
print(payload["data"]["token"])
' "$temporary_directory/login-response.json")"

install -d -m 700 "$(dirname "$TOKEN_FILE")"
printf 'OPENLIST_TOKEN=%s\n' "$service_token" > "$temporary_directory/token.env"
install -m 600 "$temporary_directory/token.env" "$TOKEN_FILE"

echo "OpenList service user created and token stored with mode 0600."
