#!/usr/bin/env bash
# DISASTER-RECOVERY DRILL — synthetic data, never production.
#
# Runs the REAL backup.sh and restore.sh from this repository against real
# Postgres 17 and Qdrant v1.12.6 containers (the production images): back up
# (encrypted, copied off-server with rclone to a local folder), destroy the
# "server", restore onto a fresh empty one from the OFF-SITE copy only, and
# compare citizens, tickets, knowledge-base vectors and files. Only `dc`
# (docker compose) and wait_healthy are re-pointed at the drill containers;
# every command the scripts run is theirs. Needs docker, rclone, python3.
#
#   deploy/single-server/tests/dr-drill.sh        (CI runs it on every change)
#
# Written 28 Nov 2026, when it found that every encrypted backup stopped
# before the off-site copy, and that the Qdrant snapshot could not be restored.
set -euo pipefail
REPO="${REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}"
W="${DRILL_DIR:-$(mktemp -d)}"
rm -rf "$W"; mkdir -p "$W/remote"
cp -r "$REPO/deploy/single-server" "$W/site"
cd "$W/site"; rm -rf backups
cat > server.env <<EOF
QDRANT_API_KEY=drill-qdrant-key
BACKUP_ENCRYPTION_KEY=drill-encryption-key-0123456789
BACKUP_REMOTE=$W/remote
BACKUP_KEEP_DAYS=14
EOF
cat > test-shim.sh <<'EOF'
# Drill wiring: `dc` talks to the drill containers instead of docker compose.
dc() {
  local cmd="$1"; shift
  case "$cmd" in
    exec) [ "$1" = "-T" ] && shift; local svc="$1"; shift; docker exec -i "drill-$svc" "$@" ;;
    run)
      local ep="" ; while [ "$#" -gt 0 ]; do case "$1" in --rm|--no-deps|-T) shift ;; --entrypoint) ep="$2"; shift 2 ;; *) break ;; esac; done
      local svc="$1"; shift
      docker run --rm -i --user 0 --network drillnet -v drill-files:/data --entrypoint "$ep" curlimages/curl:8.11.1 "$@" ;;
    up) while [ "$#" -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done
        for s in "${@:-postgres qdrant api}"; do for x in $s; do docker start "drill-$x" >/dev/null; done; done ;;
    stop) for s in "$@"; do docker stop "drill-$s" >/dev/null 2>&1 || true; done ;;
    ps) docker ps -q -f "name=^drill-${*: -1}$" ;;
  esac
}
wait_healthy() {
  local svc="$1"
  for _ in $(seq 60); do
    case "$svc" in
      postgres) docker exec drill-postgres pg_isready -U ace -d ace >/dev/null 2>&1 && return 0 ;;
      qdrant) docker run --rm --network drillnet curlimages/curl:8.11.1 -fsS -H "api-key: drill-qdrant-key" http://qdrant:6333/collections >/dev/null 2>&1 && return 0 ;;
      *) [ "$(docker inspect -f '{{.State.Status}}' "drill-$svc" 2>/dev/null)" = running ] && return 0 ;;
    esac
    sleep 1
  done
  die "$svc did not become ready"
}
EOF
echo '[ -f ./test-shim.sh ] && source ./test-shim.sh' >> lib.sh

server_up() {  # A fresh "server": empty database, empty vector store, empty file store.
  docker rm -f drill-postgres drill-qdrant drill-api >/dev/null 2>&1 || true
  docker volume rm drill-files >/dev/null 2>&1 || true
  docker network create drillnet >/dev/null 2>&1 || true
  docker run -d --name drill-postgres --network drillnet --network-alias postgres -e POSTGRES_USER=ace -e POSTGRES_PASSWORD=x -e POSTGRES_DB=ace postgres:17 >/dev/null
  docker run -d --name drill-qdrant --network drillnet --network-alias qdrant -e QDRANT__SERVICE__API_KEY=drill-qdrant-key qdrant/qdrant:v1.12.6 >/dev/null
  docker run -d --name drill-api --network drillnet --network-alias api --user 0 -v drill-files:/data --entrypoint sh curlimages/curl:8.11.1 -c 'mkdir -p /data/files; sleep 100000' >/dev/null
  for _ in $(seq 60); do docker exec drill-postgres pg_isready -U ace -d ace >/dev/null 2>&1 && break; sleep 1; done
  for _ in $(seq 60); do docker exec drill-api curl -fsS -H "api-key: drill-qdrant-key" http://qdrant:6333/collections >/dev/null 2>&1 && break; sleep 1; done
}
Q() { docker exec -i drill-api curl -fsS -H "api-key: drill-qdrant-key" -H 'Content-Type: application/json' "$@"; }
counts() {
  echo "  citizens: $(docker exec drill-postgres psql -U ace -d ace -tAc 'select count(*) from citizens' 2>/dev/null || echo none)"
  echo "  tickets:  $(docker exec drill-postgres psql -U ace -d ace -tAc "select count(*)||' (refs '||min(ref)||'..'||max(ref)||')' from tickets" 2>/dev/null || echo none)"
  for c in org_plateau org_demo; do echo "  qdrant $c: $(Q -X POST http://qdrant:6333/collections/$c/points/count -d '{}' 2>/dev/null | sed -n 's/.*"count":\([0-9]*\).*/\1/p') points"; done
  echo "  files:    $(docker exec drill-api sh -c 'ls /data/files | wc -l') ($(docker exec drill-api sh -c 'cat /data/files/recording-7.wav 2>/dev/null | md5sum | cut -c1-12'))"
}

echo "=== 1. The production stand-in, with synthetic data"
server_up
docker exec -i drill-postgres psql -U ace -d ace -q <<'SQL'
create table citizens (id serial primary key, phone text unique, name text, lga text);
create table tickets (id serial primary key, ref text unique, citizen int references citizens(id), summary text);
insert into citizens (phone, name, lga) select '+234803' || lpad(g::text, 7, '0'), 'Citizen ' || g, 'Jos South' from generate_series(1, 200) g;
insert into tickets (ref, citizen, summary) select 'PLT-' || lpad(g::text, 5, '0'), 1 + (g % 200), 'Broken borehole ' || g from generate_series(1, 545) g;
SQL
for c in org_plateau org_demo; do
  Q -X PUT http://qdrant:6333/collections/$c -d '{"vectors":{"size":8,"distance":"Cosine"}}' >/dev/null
  pts=$(python3 -c "import json,random;random.seed(1);print(json.dumps({'points':[{'id':i,'vector':[random.random() for _ in range(8)],'payload':{'chunk':i}} for i in range(1,370 if '$c'=='org_plateau' else 12)]}))")
  echo "$pts" | Q -X PUT "http://qdrant:6333/collections/$c/points?wait=true" -d @- >/dev/null
done
docker exec drill-api sh -c 'for i in $(seq 1 10); do head -c 20000 /dev/urandom > /data/files/recording-$i.wav; done'
counts | tee "$W/before.txt"

echo "=== 2. backup.sh (encrypted, copied off the server with rclone)"
./backup.sh
echo "  off-site copy holds: $(cd "$W/remote" && find . -type f | sort | tr '\n' ' ')"

echo "=== 3. The server is lost: everything destroyed, a fresh empty server"
server_up
counts

echo "=== 4. restore.sh from the OFF-SITE copy only (encrypted)"
stamp="$(ls "$W/remote")"
mkdir -p "$W/site/backups/from-remote"; cp -r "$W/remote/$stamp/." "$W/site/backups/from-remote/"
./restore.sh backups/from-remote --replace-everything
docker start drill-api >/dev/null
counts | tee "$W/after.txt"

docker rm -f drill-postgres drill-qdrant drill-api >/dev/null 2>&1 || true
echo "=== 5. Verdict"
if diff -u "$W/before.txt" "$W/after.txt"; then echo "RESTORE MATCHES THE ORIGINAL"; else echo "RESTORE DIFFERS"; exit 1; fi
