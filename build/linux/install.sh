#!/bin/sh
# Installs Libertad: the app, a "Libertad" command and a menu entry. Works from the unpacked .tar.gz,
# and from a source checkout (build/linux/install.sh), where it builds the app first.
# For you only by default; run with sudo (or --system) for everyone on this computer.
# Running it again over an installed version updates it. Your settings and identities stay.
set -eu

usage() {
  echo "Usage: install.sh [--user | --system]"
  echo "  --user    install for you only, in ~/.local (default unless run as root)"
  echo "  --system  install for everyone, in /opt (needs root)"
}

mode=user
[ "$(id -u)" -eq 0 ] && mode=system
for arg in "$@"; do
  case "$arg" in
    --user) mode=user ;;
    --system) mode=system ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if [ "$mode" = system ] && [ "$(id -u)" -ne 0 ]; then
  echo "Installing for everyone needs root: sudo $0 --system" >&2
  exit 1
fi

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
if [ -x "$here/Libertad" ] && [ -d "$here/resources" ]; then
  # The unpacked .tar.gz
  src=$here
elif [ -f "$repo/package.json" ] && grep -q '"name": "Libertad"' "$repo/package.json"; then
  # A source checkout: build the app for this computer
  src=$repo/release/linux-unpacked
  if [ "$(id -u)" -eq 0 ]; then
    # Building as root would leave root-owned files in the checkout
    if [ ! -x "$src/Libertad" ]; then
      echo "Build it as yourself first (npm run dist:linux), then run: sudo $0 --system" >&2
      exit 1
    fi
    echo "Using the build in $src"
  else
    if ! command -v npm >/dev/null 2>&1; then
      echo "Building from source needs Node.js and npm (https://nodejs.org/)." >&2
      exit 1
    fi
    echo "Building Libertad from $repo"
    (
      cd "$repo"
      [ -d node_modules ] || npm install
      npm run build
      npx electron-builder --linux dir --publish never
    )
  fi
else
  echo "Could not find Libertad next to this script, nor a source checkout around it." >&2
  echo "Run it from the unpacked .tar.gz folder, or as build/linux/install.sh in the repository." >&2
  exit 1
fi

if [ "$mode" = system ]; then
  app=/opt/Libertad
  bin=/usr/local/bin
  menu=/usr/share/applications
else
  data=${XDG_DATA_HOME:-$HOME/.local/share}
  app=$data/Libertad
  bin=$HOME/.local/bin
  menu=$data/applications
fi

if [ "$src" = "$app" ]; then
  echo "This is the installed copy; run install.sh from the .tar.gz folder or the repository." >&2
  exit 1
fi

# Only replace a folder this script made before
if [ -e "$app" ] && [ ! -f "$app/.Libertad-install" ]; then
  echo "$app exists and was not made by this installer; not touching it." >&2
  exit 1
fi

echo "Installing Libertad to $app"
tmp="$app.new.$$"
rm -rf "$tmp"
mkdir -p "$(dirname "$app")"
cp -a "$src" "$tmp"
rm -f "$tmp/install.sh"
cp "$here/uninstall.sh" "$tmp/uninstall.sh"
[ -f "$tmp/Libertad.png" ] || cp "$repo/build/icon.png" "$tmp/Libertad.png" 2>/dev/null || true
echo "$mode" > "$tmp/.Libertad-install"
rm -rf "$app"
mv "$tmp" "$app"

# Chromium's sandbox helper must belong to root with the setuid bit. Installed for you only,
# that is not possible; the app then relies on user namespaces, which most systems allow.
if [ "$mode" = system ] && [ -f "$app/chrome-sandbox" ]; then
  chown root:root "$app/chrome-sandbox"
  chmod 4755 "$app/chrome-sandbox"
fi

mkdir -p "$bin" "$menu"

# A launcher rather than a link: in a shell with ELECTRON_RUN_AS_NODE set, the app would start as Node
rm -f "$bin/Libertad"
{
  echo '#!/bin/sh'
  echo '# Libertad launcher, made by install.sh'
  echo 'unset ELECTRON_RUN_AS_NODE'
  echo "exec \"$app/Libertad\" \"\$@\""
} > "$bin/Libertad"
chmod 755 "$bin/Libertad"

{
  echo '[Desktop Entry]'
  echo 'Type=Application'
  echo 'Name=Libertad'
  echo 'Comment=Modern Mumble client'
  echo "Exec=\"$bin/Libertad\" %U"
  echo "Icon=$app/Libertad.png"
  echo 'Terminal=false'
  echo 'Categories=Network;Chat;'
  echo 'Keywords=mumble;voice;chat;voip;'
  echo 'StartupWMClass=Libertad'
} > "$menu/Libertad.desktop"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$menu" 2>/dev/null || true

echo "Done. Start it from your app menu or with: Libertad"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Note: $bin is not on your PATH, so the command needs its full path: $bin/Libertad" ;;
esac
echo "To remove it: $app/uninstall.sh"
