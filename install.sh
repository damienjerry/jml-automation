#!/usr/bin/env bash
#
# jml-automation installer for macOS and Linux (and Windows through WSL2).
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
#   --preview     see what a new user sees: checks and builds as usual, then
#                 walks the whole setup wizard with every real question, in a
#                 temporary folder deleted at the end. Nothing is installed
#                 with Homebrew, nothing is kept, and no step acts
#   --no-docker   set up the command line tool only, without Docker and n8n
#   --yes         build without asking, once you have checked the commit
#   --help
#
# Environment:
#   JML_DIR       where to clone (default: ~/jml-automation)
#   JML_REF       branch, tag or full commit to build (default: v1.0d, the
#                 fixed release holding setups 1.0a and 1.0b). A branch moves
#                 after you read it; pin a tag or a commit you reviewed.
#   JML_REPO_URL  repository to clone

set -euo pipefail

REPO_URL="${JML_REPO_URL:-https://github.com/damienjerry/jml-automation.git}"
DIR="${JML_DIR:-$HOME/jml-automation}"
REF="${JML_REF:-v1.0d}"
DRY=0
NO_DOCKER=0
ASSUME_YES=0
PREVIEW=0

usage() { sed -n '3,38p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --preview) PREVIEW=1 ;;
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

# Which platform, and on Linux which package manager. WSL2 is Linux, and is how
# this runs on Windows: native Windows has no installer.
OS="$(uname -s)"
PLATFORM=other
if [ "$OS" = "Darwin" ]; then PLATFORM=mac
elif [ "$OS" = "Linux" ]; then
  PLATFORM=linux
  grep -qi microsoft /proc/version 2>/dev/null && PLATFORM=wsl
fi
PKG=""
if [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "wsl" ]; then
  if command -v apt-get >/dev/null 2>&1; then PKG=apt
  elif command -v dnf >/dev/null 2>&1; then PKG=dnf
  fi
fi

say "jml-automation installer"
note "clone into: $DIR"
note "build:      $REF of $REPO_URL"
case "$PLATFORM" in
  mac) note "platform:   macOS" ;;
  linux) note "platform:   Linux${PKG:+ ($PKG)}" ;;
  wsl) note "platform:   Windows, through WSL2${PKG:+ ($PKG)}" ;;
  *) note "platform:   $OS, which this has not been written for; carrying on, with no install offers" ;;
esac
[ "$DRY" -eq 1 ] && note "dry run: nothing will be changed"
[ "$PREVIEW" -eq 1 ] && note "preview: nothing is installed; the wizard runs in a temporary folder and keeps nothing"

# Offer to install a package with the platform's own manager, never anything
# piped from the internet into a shell.
offer_install() { # $1 what, $2 brew formula or empty, $3 apt/dnf package or empty
  [ "$PREVIEW" -eq 1 ] && return 1
  if [ "$PLATFORM" = "mac" ] && [ -n "$2" ] && command -v brew >/dev/null 2>&1; then
    # $2 is split on purpose: "--cask docker" is two arguments.
    # shellcheck disable=SC2086
    yes_to "Install $1 with Homebrew (brew install $2)?" && { run brew install $2; return 0; }
  elif [ -n "$3" ] && [ "$PKG" = "apt" ]; then
    yes_to "Install $1 with apt (sudo apt-get install -y $3)?" && { run sudo apt-get install -y "$3"; return 0; }
  elif [ -n "$3" ] && [ "$PKG" = "dnf" ]; then
    yes_to "Install $1 with dnf (sudo dnf install -y $3)?" && { run sudo dnf install -y "$3"; return 0; }
  fi
  return 1
}

say "1. prerequisites"
if ! command -v git >/dev/null 2>&1; then
  note "git is missing."
  if [ "$PLATFORM" = "mac" ]; then
    note "Run: xcode-select --install"
    note "It opens Apple's installer for the command line tools, which include git. Then run this again."
    exit 1
  fi
  if ! offer_install git "" git || ! command -v git >/dev/null 2>&1; then
    [ "$DRY" -eq 1 ] || { note "Install git with your package manager, then run this again."; exit 1; }
  fi
fi
command -v git >/dev/null 2>&1 && note "git: $(git --version)"

node_help() {
  case "$PLATFORM" in
    mac) note "Install Node 22 from https://nodejs.org (the LTS installer), or install Homebrew from https://brew.sh and run this again to be offered it." ;;
    *) note "Install Node 22 LTS from https://nodejs.org/en/download (a prebuilt binary, or a version manager such as nvm)."
       note "Distribution packages are often older than 22.13; check with node -v." ;;
  esac
  note "Then run this again."
}

if node_ok; then
  note "node: $(node -p 'process.versions.node')"
else
  note "Node 22.13 or newer is needed (found: $(command -v node >/dev/null 2>&1 && node -p 'process.versions.node' || echo none))."
  if [ "$PREVIEW" -eq 1 ]; then
    note "The preview needs Node 22.13 or newer to run the wizard."
    node_help
    exit 1
  fi
  # Homebrew only: a distribution's node package is too often older than 22.13
  # to offer blindly.
  if [ "$PLATFORM" = "mac" ] && offer_install "Node 22" node@22 ""; then
    PATH="$(brew --prefix node@22)/bin:$PATH"; export PATH
    note "for new shells, add this to your profile: export PATH=\"$(brew --prefix node@22)/bin:\$PATH\""
  fi
  if [ "$DRY" -eq 0 ] && ! node_ok; then
    node_help
    exit 1
  fi
fi

docker_help() {
  if command -v docker >/dev/null 2>&1; then
    case "$PLATFORM" in
      mac) note "Start Docker Desktop and run this again." ;;
      wsl) note "Start Docker Desktop on Windows with WSL integration turned on for this distribution, or start Docker Engine inside WSL, then run this again." ;;
      *) note "Start it (sudo systemctl start docker). If it is running, your user may not be allowed to use it: sudo usermod -aG docker \$USER, then log out and in. Then run this again." ;;
    esac
  else
    case "$PLATFORM" in
      mac) note "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ (or install Homebrew from https://brew.sh and run this again to be offered it), open it once, then run this again." ;;
      wsl) note "Install Docker Desktop for Windows and turn on WSL integration for this distribution (https://docs.docker.com/desktop/features/wsl/), then run this again." ;;
      *) note "Install Docker Engine for your distribution (https://docs.docker.com/engine/install/), then run this again." ;;
    esac
  fi
  note "Or run ./install.sh --no-docker to set up the command line tool alone."
}

if [ "$NO_DOCKER" -eq 0 ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    note "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo running)"
  else
    note "Docker is not running, or this user cannot reach it. It runs the sidecar and n8n; the command line tool works without it."
    if [ "$PREVIEW" -eq 1 ]; then
      note "(preview) A real install stops here with what to do next, or carries on without Docker. The preview carries on."
    elif [ "$PLATFORM" = "mac" ] && ! command -v docker >/dev/null 2>&1 && offer_install "Docker Desktop" "--cask docker" ""; then
      note "Open Docker Desktop once from Applications so it can finish installing, then run this again."
      exit 0
    elif yes_to "Carry on without Docker (command line only)?"; then
      NO_DOCKER=1
    elif [ "$DRY" -eq 0 ]; then
      docker_help
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
[ "$PREVIEW" -eq 1 ] && SETUP_ARGS+=(--preview)
[ "$NO_DOCKER" -eq 1 ] && SETUP_ARGS+=(--no-docker)
if [ "$DRY" -eq 1 ]; then
  note "would run: (cd $DIR && node bin/jml.mjs ${SETUP_ARGS[*]})"
  exit 0
fi
cd "$DIR"
exec node bin/jml.mjs "${SETUP_ARGS[@]}"
