#!/usr/bin/env bash
#
# jml-automation installer for macOS.
#
# Read this file before you run it. It is short on purpose, and it does five
# things, each printed before it happens:
#
#   1. checks for git, Node 22.13 or newer, and Docker (it offers to install
#      Node and Docker Desktop with Homebrew, and does nothing without a yes)
#   2. clones the repository, or updates an existing clone, prints the exact
#      commit it will build, and STOPS until you say yes: nothing is installed
#      or built from code you have not had the chance to compare with GitHub
#   3. installs dependencies with --ignore-scripts, so no third-party package
#      runs code on this machine during the install
#   4. builds from the source you just cloned (the TypeScript compiler, and the
#      repository's own copy script)
#   5. hands over to `jml setup`, the guided configuration, which asks before
#      it writes anything outside the clone and arms nothing
#
# Network: github.com for the clone, registry.npmjs.org for dependencies, and
# Homebrew's servers only if you say yes to installing Node or Docker. Nothing
# else. No telemetry.
#
# Options:
#   --dry-run     print every command instead of running it
#   --no-docker   set up the command line tool only, without Docker and n8n
#   --yes         build without asking, once you have checked the commit
#   --help
#
# Environment:
#   JML_DIR       where to clone (default: ~/jml-automation)
#   JML_REF       branch, tag or full commit to build (default: v1.0.0, the
#                 fixed release). A branch moves after you read it; pin a tag
#                 or a commit you reviewed.
#   JML_REPO_URL  repository to clone

set -euo pipefail

REPO_URL="${JML_REPO_URL:-https://github.com/damienjerry/jml-automation.git}"
DIR="${JML_DIR:-$HOME/jml-automation}"
REF="${JML_REF:-v1.0.0}"
DRY=0
NO_DOCKER=0
ASSUME_YES=0

usage() { sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-docker) NO_DOCKER=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
run()  { if [ "$DRY" -eq 1 ]; then printf '   would run: %s\n' "$*"; else printf '   + %s\n' "$*"; "$@"; fi; }
yes_to() {
  if [ "$DRY" -eq 1 ]; then note "would ask: $1"; return 1; fi
  local answer; read -r -p "   $1 [y/N] " answer || answer=""
  [[ "$answer" =~ ^[Yy] ]]
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -p 'process.versions.node')"; major="${v%%.*}"; minor="$(printf '%s' "$v" | cut -d. -f2)"
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }
}

say "jml-automation installer"
note "clone into: $DIR"
note "build:      $REF of $REPO_URL"
[ "$DRY" -eq 1 ] && note "dry run: nothing will be changed"
[ "$(uname -s)" = "Darwin" ] || note "this is written for macOS; carrying on, but the Homebrew offers will not apply"

say "1. prerequisites"
if ! command -v git >/dev/null 2>&1; then
  note "git is missing. On a Mac: xcode-select --install, then run this again."
  exit 1
fi
note "git: $(git --version)"

if node_ok; then
  note "node: $(node -p 'process.versions.node')"
else
  note "Node 22.13 or newer is needed (found: $(command -v node >/dev/null 2>&1 && node -p 'process.versions.node' || echo none))."
  if command -v brew >/dev/null 2>&1 && yes_to "Install it with Homebrew (brew install node@22)?"; then
    run brew install node@22
    PATH="$(brew --prefix node@22)/bin:$PATH"; export PATH
    note "for new shells, add this to your profile: export PATH=\"$(brew --prefix node@22)/bin:\$PATH\""
  fi
  if [ "$DRY" -eq 0 ] && ! node_ok; then
    note "Install Node 22 from https://nodejs.org or Homebrew, then run this again."
    exit 1
  fi
fi

if [ "$NO_DOCKER" -eq 0 ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    note "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo running)"
  else
    note "Docker is not running. It runs the sidecar and n8n; the command line tool works without it."
    if ! command -v docker >/dev/null 2>&1 && command -v brew >/dev/null 2>&1 && yes_to "Install Docker Desktop with Homebrew (brew install --cask docker)?"; then
      run brew install --cask docker
      note "Open Docker Desktop once from Applications so it can finish installing, then run this again."
      exit 0
    fi
    if yes_to "Carry on without Docker (command line only)?"; then
      NO_DOCKER=1
    elif [ "$DRY" -eq 0 ]; then
      note "Start Docker Desktop and run this again."
      exit 1
    fi
  fi
fi

say "2. source"
if [ -d "$DIR/.git" ]; then
  note "$DIR is already a clone; updating it"
  run git -C "$DIR" fetch --tags origin
  run git -C "$DIR" checkout "$REF"
  if [ "$DRY" -eq 1 ] || git -C "$DIR" symbolic-ref -q HEAD >/dev/null; then run git -C "$DIR" pull --ff-only origin "$REF"; fi
elif [ -e "$DIR" ]; then
  note "$DIR exists and is not a git clone. Move it, or set JML_DIR, and run this again."
  exit 1
else
  # Clone then check out, so JML_REF can be a branch, a tag or a full commit.
  run git clone "$REPO_URL" "$DIR"
  run git -C "$DIR" checkout "$REF"
fi
if [ "$DRY" -eq 0 ]; then
  SHA="$(git -C "$DIR" rev-parse HEAD)"
  note "about to install dependencies for and build commit $SHA"
  note "compare it with ${REPO_URL%.git}/commit/$SHA"
  if git -C "$DIR" symbolic-ref -q HEAD >/dev/null; then
    note "that is the tip of a branch, which can move; set JML_REF to this commit to pin exactly what you checked"
  fi
  if [ "$ASSUME_YES" -eq 0 ] && ! yes_to "Build this commit?"; then
    note "Nothing was installed or built. The clone is in $DIR for you to read."
    exit 0
  fi
fi

say "3. dependencies (no package install scripts run)"
if [ "$DRY" -eq 1 ]; then note "would run: (cd $DIR && npm ci --ignore-scripts --no-audit --no-fund)"; else (cd "$DIR" && run npm ci --ignore-scripts --no-audit --no-fund); fi

say "4. build"
if [ "$DRY" -eq 1 ]; then note "would run: (cd $DIR && npm run build)"; else (cd "$DIR" && run npm run build); fi

say "5. guided setup"
SETUP_ARGS=(setup)
[ "$NO_DOCKER" -eq 1 ] && SETUP_ARGS+=(--no-docker)
if [ "$DRY" -eq 1 ]; then
  note "would run: (cd $DIR && node bin/jml.mjs ${SETUP_ARGS[*]})"
  exit 0
fi
cd "$DIR"
exec node bin/jml.mjs "${SETUP_ARGS[@]}"
