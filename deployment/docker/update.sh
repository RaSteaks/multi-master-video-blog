#!/usr/bin/env bash
set -Eeuo pipefail
# Explicit maintenance operation; no database migrations, pulls or volume deletion.
[[ $# == 2 ]] || { echo "Usage: $0 low-2gb|low-4gb UNIQUE_RELEASE_TAG" >&2; exit 2; }
profile=$1
[[ $profile == low-2gb || $profile == low-4gb ]] || exit 2
[[ $2 =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$ ]] || { echo 'Invalid release tag.' >&2; exit 2; }
export RELEASE_TAG=$2
cd "$(dirname "$0")"
exec 9>.update.lock
flock -n 9 || { echo 'Another update is running.' >&2; exit 1; }
if [[ $profile == low-2gb ]] && (( $(awk '/^SwapTotal:/ {print $2}' /proc/meminfo) < 2097152 )); then
  echo '2GB builds require at least 2GiB configured swap.' >&2; exit 1
fi
args=(--env-file .env)
[[ -f .release.env ]] && args+=(--env-file .release.env)
args+=(-f compose.yaml -f "compose.$profile.yaml")
# Explicit opt-ins are preserved across build, restart and rollback.
[[ ${ENABLE_HTTPS:-false} == true ]] && args+=(-f compose.https.yaml)
[[ ${ENABLE_VULKAN:-false} == true ]] && args+=(-f compose.vulkan.yaml)
dc() { docker compose "${args[@]}" "$@"; }
dc config --quiet
running=()
rollback=$(mktemp)
previous_release=$(mktemp)
if [[ -f .release.env ]]; then cp .release.env "$previous_release"; else printf 'RELEASE_TAG=local\n' > "$previous_release"; fi
printf '{"services":{' > "$rollback"
separator=''
for service in cms api web nginx; do
  container=$(dc ps -q "$service")
  if [[ -n $container ]]; then
    running+=("$service")
    image=$(docker inspect --format '{{.Image}}' "$container")
    printf '%s"%s":{"image":"%s","pull_policy":"never"}' "$separator" "$service" "$image" >> "$rollback"
    separator=,
  fi
done
printf '}}' >> "$rollback"
[[ ${#running[@]} == 4 ]] || { rm -f "$rollback" "$previous_release"; echo 'Use the first-install procedure unless all four application services are running.' >&2; exit 1; }
for service in cms api web; do
  if docker image inspect "video-blog-$service:$RELEASE_TAG" >/dev/null 2>&1; then
    rm -f "$rollback" "$previous_release"; echo "Release tag already exists: $RELEASE_TAG" >&2; exit 1
  fi
done
success=false
stopped=false
restore() {
  result=$?
  trap - EXIT
  if [[ $success != true && $stopped == true ]]; then
    docker compose "${args[@]}" -f "$rollback" up -d --no-build --pull never --wait --wait-timeout 300 "${running[@]}" || echo 'Rollback needs administrator attention.' >&2
  fi
  dc exec -T api node /app/scripts/maintenance.cjs off || true
  if [[ $success == true ]]; then
    # Keep the exact previous image IDs for a later explicit rollback.
    mv "$rollback" "rollback-$RELEASE_TAG.json"
    mv "$previous_release" "rollback-$RELEASE_TAG.env"
  else rm -f "$rollback" "$previous_release"; fi
  exit "$result"
}
trap restore EXIT
dc exec -T api node /app/scripts/maintenance.cjs drain
stopped=true
dc stop nginx web api cms
for service in cms api web; do dc build "$service"; done
dc up -d --no-build --pull never --wait --wait-timeout 300 cms api web nginx
# Persist the active tag separately from secrets so later compose commands stay on it.
printf 'RELEASE_TAG=%s\n' "$RELEASE_TAG" > .release.env.next
mv .release.env.next .release.env
success=true
printf 'Release active: %s. Previous images recorded in rollback-%s.json.\n' "$RELEASE_TAG" "$RELEASE_TAG"
