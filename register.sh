#!/usr/bin/env bash
# Register mcp-planka with Claude Code (default: user scope = available in all projects).
#
# Usage: ./register.sh [--mode auto|node|docker|podman] [--yes] [--name planka]
#                      [--scope user|local|project] [--config /path/.planka] [--files-dir DIR] [--dry-run]
#   --mode     how to run the server; auto (default) tests what works here, recommends one and asks
#   --yes      take the recommended mode without asking (also used when there is no terminal)
#   --config   use a specific .planka file (e.g. another user's API key); default: .planka in the repo
#   --files-dir  folder the attachment tools may read/write (PLANKA_FILES_DIR); mounted as /files in containers
#   --dry-run  print what would be done, change nothing
set -euo pipefail

NAME="planka"
SCOPE="user"
CONFIG=""
FILES_DIR=""
MODE="auto"
YES=0
DRY=0
IMAGE="mcp-planka:latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)    MODE="$2"; shift 2 ;;
    --yes|-y)  YES=1; shift ;;
    --name)    NAME="$2"; shift 2 ;;
    --scope)   SCOPE="$2"; shift 2 ;;
    --config)  CONFIG="$2"; shift 2 ;;
    --files-dir) FILES_DIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
run() { if [[ $DRY -eq 1 ]]; then echo "[dry-run] $*" >&2; else "$@"; fi; }
die() { echo "error: $*" >&2; exit 1; }

case "$SCOPE" in user|local|project) ;; *) die "--scope must be user, local or project" ;; esac
case "$MODE" in auto|node|docker|podman) ;; *) die "--mode must be auto, node, docker or podman" ;; esac
command -v claude >/dev/null || die "claude CLI not found (install Claude Code first: https://docs.claude.com/claude-code)"

# --- Config file -------------------------------------------------------------
if [[ -n "$CONFIG" ]]; then
  CONFIG="$(cd "$(dirname "$CONFIG")" && pwd -P)/$(basename "$CONFIG")"
  [[ -f "$CONFIG" ]] || die "config file not found: $CONFIG"
elif [[ -f "$ROOT/.planka" ]]; then
  CONFIG="$ROOT/.planka"
elif [[ -z "${PLANKA_URL:-}" || -z "${PLANKA_API_KEY:-}" ]]; then
  die "no $ROOT/.planka (URL=... / KEY=... / MANAGERS=...) and PLANKA_URL/PLANKA_API_KEY not set"
fi
if [[ -n "$CONFIG" ]]; then
  perms="$(stat -c %a "$CONFIG" 2>/dev/null || echo 600)"
  if (( (8#$perms & 8#077) != 0 )); then
    echo "warning: $CONFIG ($perms) is readable by other users; consider: chmod 600 $CONFIG"
  fi
fi

if [[ -n "$FILES_DIR" ]]; then
  [[ -d "$FILES_DIR" ]] || die "--files-dir: not a directory: $FILES_DIR"
  FILES_DIR="$(cd "$FILES_DIR" && pwd -P)"
fi

# --- Detect what works on this host -----------------------------------------
NODE_OK=0; NODE_INFO="not installed"
if command -v node >/dev/null && command -v npm >/dev/null; then
  NODE_INFO="$(node -v)"
  if node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then NODE_OK=1; else NODE_INFO="$NODE_INFO (too old, need >= 20)"; fi
elif command -v node >/dev/null; then
  NODE_INFO="$(node -v), but npm missing"
fi

probe_runtime() { # $1 = docker|podman -> sets <RT>_OK and <RT>_INFO
  local rt="$1" ok=0 info="not installed"
  if command -v "$rt" >/dev/null; then
    info="$("$rt" --version 2>/dev/null | head -1)"
    if timeout 15 "$rt" info >/dev/null 2>&1; then ok=1
    else info="$info, but '$rt info' failed (daemon not running or no permission)"; fi
  fi
  printf -v "${rt^^}_OK" '%s' "$ok"; printf -v "${rt^^}_INFO" '%s' "$info"
}
probe_runtime docker
probe_runtime podman

# Recommendation: Node runs natively (fastest start, no image to maintain); otherwise a working
# container runtime, preferring Podman (daemonless, rootless by default).
RECOMMENDED=""
if   [[ $NODE_OK -eq 1 ]];   then RECOMMENDED="node"
elif [[ $PODMAN_OK -eq 1 ]]; then RECOMMENDED="podman"
elif [[ $DOCKER_OK -eq 1 ]]; then RECOMMENDED="docker"
fi

mark() { [[ $1 -eq 1 ]] && echo "ok " || echo "-- "; }
echo "Detected on $(hostname):"
echo "  [$(mark $NODE_OK)] node    $NODE_INFO"
echo "  [$(mark $DOCKER_OK)] docker  $DOCKER_INFO"
echo "  [$(mark $PODMAN_OK)] podman  $PODMAN_INFO"

if [[ -z "$RECOMMENDED" && "$MODE" == "auto" ]]; then
  cat >&2 <<'EOF'

error: nothing usable found. Install one of:
  Node 22 (Debian/Ubuntu):  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  Podman:                   apt-get install -y podman
  Docker:                   https://docs.docker.com/engine/install/
Then run ./register.sh again.
EOF
  exit 1
fi

# --- Choose ------------------------------------------------------------------
if [[ "$MODE" == "auto" ]]; then
  MODE="$RECOMMENDED"
  if [[ $YES -eq 0 && -t 0 ]]; then
    echo
    echo "How should Claude Code run the server?"
    opts=(node docker podman)
    desc=("Node.js on this host (npm install + build here)"
          "Docker container (image $IMAGE)"
          "Podman container (image $IMAGE)")
    oks=($NODE_OK $DOCKER_OK $PODMAN_OK)
    for i in 0 1 2; do
      tag=""; [[ "${opts[$i]}" == "$RECOMMENDED" ]] && tag="  (recommended)"
      [[ ${oks[$i]} -eq 1 ]] || tag="  (not available)"
      echo "  $((i + 1))) ${desc[$i]}$tag"
    done
    default=1; for i in 0 1 2; do [[ "${opts[$i]}" == "$RECOMMENDED" ]] && default=$((i + 1)); done
    read -r -p "Choice [$default]: " choice
    choice="${choice:-$default}"
    [[ "$choice" =~ ^[1-3]$ ]] || die "invalid choice: $choice"
    MODE="${opts[$((choice - 1))]}"
  else
    echo "Using recommended mode: $MODE"
  fi
fi
case "$MODE" in
  node)   [[ $NODE_OK -eq 1 ]]   || die "node mode needs Node >= 20 with npm ($NODE_INFO)" ;;
  docker) [[ $DOCKER_OK -eq 1 ]] || die "docker mode needs a working Docker ($DOCKER_INFO)" ;;
  podman) [[ $PODMAN_OK -eq 1 ]] || die "podman mode needs a working Podman ($PODMAN_INFO)" ;;
esac
echo "Mode: $MODE"

# --- Prepare + verify ---------------------------------------------------------
if [[ "$MODE" == "node" ]]; then
  ENTRY="$ROOT/dist/index.js"
  cd "$ROOT"
  if [[ ! -d node_modules ]]; then echo "Installing dependencies..."; run npm install --no-fund --no-audit; fi
  if [[ ! -f "$ENTRY" ]] || [[ -n "$(find src -newer "$ENTRY" -name '*.ts' -print -quit)" ]]; then
    echo "Building (dist/ missing or older than src/)..."; run npm run build --silent
  fi
  CHECK=(env ${CONFIG:+PLANKA_CONFIG="$CONFIG"} node "$ROOT/dist/check.js")
  SERVER=(node "$ENTRY")
  ENV_ARGS=(); [[ -n "$CONFIG" ]] && ENV_ARGS=(-e "PLANKA_CONFIG=$CONFIG")
  [[ -n "$FILES_DIR" ]] && ENV_ARGS+=(-e "PLANKA_FILES_DIR=$FILES_DIR")
else
  RT="$MODE"
  echo "Building image $IMAGE with $RT..."
  run "$RT" build -q -t "$IMAGE" "$ROOT" >/dev/null
  [[ -n "$CONFIG" ]] || die "$RT mode needs a .planka file (env-only config isn't passed into the container)"
  VOL_OPTS="ro"; [[ "$RT" == "podman" ]] && VOL_OPTS="ro,z"   # z: SELinux relabel for Podman hosts
  RUN_ARGS=(run -i --rm --pull=never -v "$CONFIG:/app/.planka:$VOL_OPTS" -v mcp-planka-state:/data)
  if [[ -n "$FILES_DIR" ]]; then
    FILES_OPTS="rw"; [[ "$RT" == "podman" ]] && FILES_OPTS="rw,z"
    RUN_ARGS+=(-v "$FILES_DIR:/files:$FILES_OPTS" -e PLANKA_FILES_DIR=/files)
  fi
  CHECK=("$RT" "${RUN_ARGS[@]}" --entrypoint node "$IMAGE" dist/check.js)
  SERVER=("$RT" "${RUN_ARGS[@]}" "$IMAGE")
  ENV_ARGS=()
fi

if [[ $DRY -eq 0 ]]; then
  echo "Checking Planka connection..."
  "${CHECK[@]}" 2>&1 | sed 's/^/  /' || die "Planka check failed (wrong URL/KEY in ${CONFIG:-env}?)"
else
  echo "[dry-run] ${CHECK[*]}"
fi

# --- Register -------------------------------------------------------------------
for s in local user project; do
  if claude mcp get "$NAME" 2>/dev/null | grep -qi "scope: *$s"; then
    echo "Removing existing '$NAME' ($s scope)..."; run claude mcp remove "$NAME" -s "$s"
  fi
done

echo "Registering '$NAME' ($SCOPE scope, $MODE)..."
# Name before -e: newer Claude Code versions read -e as a list and would take the name as a variable.
run claude mcp add -s "$SCOPE" "$NAME" "${ENV_ARGS[@]}" -- "${SERVER[@]}"

if [[ $DRY -eq 0 ]]; then
  claude mcp get "$NAME" | sed 's/^/  /'
  echo
  echo "Done. Restart Claude Code (e.g. 'claude --continue') - /mcp only shows servers loaded at session start."
  [[ "$MODE" != "node" ]] && echo "After code changes (git pull), run ./register.sh again to rebuild the image."
fi
exit 0
