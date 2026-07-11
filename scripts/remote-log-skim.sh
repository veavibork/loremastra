#!/bin/bash
set -euo pipefail
cd /opt/loremaster

echo "=== deployed commit ==="
git log -1 --oneline

echo
echo "=== story 019f25e0 prose jobs (last 25) ==="
sqlite3 data/stories/019f25e0-219c-7189-b481-9f389a9a3c39.sqlite <<'SQL'
.mode column
.headers on
SELECT datetime(created_at) AS created, status, model, elapsed_ms,
       CASE WHEN error IS NULL THEN '' ELSE substr(error, 1, 120) END AS error
FROM jobs WHERE job_type = 'prose'
ORDER BY created_at DESC LIMIT 25;
SQL

echo
echo "=== all stories: failed jobs with reasoning/empty errors ==="
for db in data/stories/*.sqlite; do
  hits=$(sqlite3 "$db" "SELECT COUNT(*) FROM jobs WHERE error LIKE '%reasoning%' OR error LIKE '%empty completion%';")
  if [ "$hits" != "0" ]; then
    echo "--- $db ($hits hits) ---"
    sqlite3 "$db" <<SQL
.mode line
SELECT datetime(created_at) AS created, job_type, status, model, error
FROM jobs
WHERE error LIKE '%reasoning%' OR error LIKE '%empty completion%'
ORDER BY created_at DESC LIMIT 8;
SQL
  fi
done

echo
echo "=== journal: inference-related (last 48h, last 50 lines) ==="
sudo journalctl -u loremaster --since "48 hours ago" --no-pager 2>/dev/null \
  | grep -iE 'reasoning|empty completion|Featherless|503|pipeline' \
  | tail -50 || echo "(no matches or journal unavailable)"

echo
echo "=== outbound-requests.log ==="
if [ -f data/outbound-requests.log ]; then
  echo "lines: $(wc -l < data/outbound-requests.log)"
  echo "last 3 models/times:"
  tail -3 data/outbound-requests.log | while read -r line; do
    echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('at'), d.get('model'), d.get('call'))" 2>/dev/null || echo "$line" | head -c 120
  done
else
  echo "(missing)"
fi
