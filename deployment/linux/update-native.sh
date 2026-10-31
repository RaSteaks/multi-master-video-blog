#!/usr/bin/env bash
set -Eeuo pipefail
# Explicit administrator operation: build a committed revision, then atomically switch.
[[ $# == 2 ]] || { echo "Usage: $0 SOURCE_REPOSITORY GIT_REF" >&2; exit 2; }
[[ $EUID == 0 ]] || { echo "Run as root (services are built/run as video-blog)." >&2; exit 2; }
source_repo=$(realpath "$1")
revision=$(git -C "$source_repo" rev-parse --verify "$2^{commit}")
exec 9>/run/video-blog-update.lock
flock -n 9 || { echo 'Another update is running.' >&2; exit 1; }
# Match systemd precedence: shared settings, then the web service's overrides.
profile=$(/usr/bin/node --env-file=/etc/video-blog/resources.env --env-file=/etc/video-blog/web.env -e 'console.log(process.env.RESOURCE_PROFILE || "default")')
[[ $profile == low-2gb || $profile == low-4gb ]] || { echo 'Select a low-resource profile first.' >&2; exit 1; }
if [[ $profile == low-2gb ]] && (( $(awk '/^SwapTotal:/ {print $2}' /proc/meminfo) < 2097152 )); then
  echo '2GB builds require at least 2GiB configured swap; no swap is created automatically.' >&2; exit 1
fi
previous=$(readlink -f /opt/video-blog/current)
release=/opt/video-blog/releases/$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}
[[ ! -e $release ]] || { echo 'Release path already exists.' >&2; exit 1; }
running=()
for service in cms api web; do
  if systemctl is-active --quiet "video-blog-$service"; then running+=("video-blog-$service"); fi
done
maintenance=false
switched=false
success=false
restore() {
  result=$?
  trap - EXIT
  if [[ $success != true ]]; then
    if [[ $switched == true ]]; then
      systemctl stop video-blog-web video-blog-api video-blog-cms || true
      ln -s "$previous" /opt/video-blog/current.rollback
      mv -Tf /opt/video-blog/current.rollback /opt/video-blog/current
    fi
    if (( ${#running[@]} )); then systemctl start "${running[@]}" || true; fi
    echo "Update failed; previous release restored. Failed build retained at $release." >&2
  fi
  if [[ $maintenance == true ]] && systemctl is-active --quiet video-blog-api; then
    API_ENV_FILE=/etc/video-blog/api.env /usr/bin/node "$previous/scripts/maintenance.cjs" off || true
  fi
  exit "$result"
}
trap restore EXIT
if systemctl is-active --quiet video-blog-api; then
  maintenance=true
  API_ENV_FILE=/etc/video-blog/api.env /usr/bin/node "$previous/scripts/maintenance.cjs" drain
fi
if (( ${#running[@]} )); then systemctl stop "${running[@]}"; fi
install -d -o video-blog -g video-blog "$release"
git -C "$source_repo" archive "$revision" | tar -x -C "$release"
chown -R video-blog:video-blog "$release"
# npm and Next run sequentially while the previous .next tree remains untouched.
(cd "$release" && runuser -u video-blog -- env NODE_OPTIONS=--max-old-space-size=768 npm_config_jobs=1 npm ci --no-audit --no-fund)
# Node parses these files as data; do not source secrets as shell code.
(cd "$release" && runuser -u video-blog -- env CMS_RUNTIME_ONLY=true /usr/bin/node --env-file=/etc/video-blog/resources.env --env-file=/etc/video-blog/web.env scripts/run-service.cjs build)
install -d -o video-blog -g video-blog /var/lib/video-blog/tmp /var/lib/video-blog/content /var/lib/video-blog/.private-media/film-scans
ln -s /var/lib/video-blog/tmp "$release/apps/api/tmp"
ln -s /var/lib/video-blog/content/about.md "$release/apps/web/content/about.md"
ln -s "$release" /opt/video-blog/current.next
mv -Tf /opt/video-blog/current.next /opt/video-blog/current
switched=true
if (( ${#running[@]} )); then systemctl start "${running[@]}"; fi
for service in "${running[@]}"; do
  case $service in
    video-blog-cms) url=http://127.0.0.1:8055/server/health;;
    video-blog-api) url=http://127.0.0.1:8060/health;;
    video-blog-web) url=http://127.0.0.1:3000/;;
  esac
  healthy=false
  for (( attempt=0; attempt<60; attempt++ )); do
    # CMS health now authenticates; retain its database/storage checks.
    if [[ $service == video-blog-cms ]]; then
      if CMS_ENV_FILE=/etc/video-blog/cms.env /usr/bin/node "$release/scripts/directus-health.cjs" >/dev/null; then healthy=true; break; fi
    elif curl --fail --silent --max-time 5 "$url" >/dev/null; then healthy=true; break; fi
    sleep 3
  done
  [[ $healthy == true ]] || { echo "$service failed readiness." >&2; exit 1; }
done
success=true
printf 'Release active: %s\nPrevious release: %s\n' "$release" "$previous"
