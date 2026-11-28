# Qdrant (the knowledge base's vectors) in a backup, one snapshot per
# collection. Sourced by backup.sh and restore.sh, never run. The caller
# defines qcurl: curl to Qdrant with its key (backup.sh: inside the api
# container, which reaches http://qdrant:6333).
#
# Per collection, because Qdrant 1.12.6 restores only a COLLECTION snapshot
# through its API. The whole-storage snapshot (POST /snapshots) that backups
# held until 28 Nov 2026 is refused by the upload API ("missing field
# `params`"), so a server rebuilt from one had no knowledge base.

QDRANT_URL_IN="${QDRANT_URL_IN:-http://qdrant:6333}"

qdrant_collections() {
  qcurl "$QDRANT_URL_IN/collections" | grep -o '"name":"[^"]*"' | sed 's/^"name":"\(.*\)"$/\1/'
}

# Write one <collection>.snapshot per collection into $1/qdrant. Prints the count.
qdrant_backup() {
  local out="$1/qdrant" c snap n=0
  mkdir -p "$out"
  for c in $(qdrant_collections); do
    snap="$(qcurl -X POST "$QDRANT_URL_IN/collections/$c/snapshots?wait=true" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
    [ -n "$snap" ] || { echo "ERROR: Qdrant made no snapshot of $c" >&2; return 1; }
    qcurl "$QDRANT_URL_IN/collections/$c/snapshots/$snap" > "$out/$c.snapshot"
    [ -s "$out/$c.snapshot" ] || { echo "ERROR: the snapshot of $c is empty" >&2; return 1; }
    # The copy is in the backup now; leaving it in Qdrant's own storage fills its disk night after night.
    qcurl -X DELETE "$QDRANT_URL_IN/collections/$c/snapshots/$snap" > /dev/null || true
    n=$((n + 1))
  done
  echo "$n"
}

# Restore every $1/qdrant/<collection>.snapshot, replacing the collection. Prints the count.
qdrant_restore() {
  local f c n=0
  for f in "$1"/qdrant/*.snapshot; do
    [ -f "$f" ] || continue
    c="$(basename "$f" .snapshot)"
    qcurl -X POST -F "snapshot=@-;filename=$c.snapshot" "$QDRANT_URL_IN/collections/$c/snapshots/upload?priority=snapshot" < "$f" \
      | grep -q '"result":true' || { echo "ERROR: Qdrant refused the snapshot of $c" >&2; return 1; }
    n=$((n + 1))
  done
  echo "$n"
}
