#!/bin/sh
# Removes Libertad installed by install.sh: the app, the "Libertad" command and the menu entry.
# Settings and identities stay unless --purge is given.
set -eu

usage() {
  echo "Usage: uninstall.sh [--user | --system] [--purge] [--yes]"
  echo "  --user    remove the copy in ~/.local (default unless run as root)"
  echo "  --system  remove the copy in /opt (needs root)"
  echo "  --purge   also delete your settings, identities (certificates) and kept files"
  echo "  --yes     do not ask before deleting them"
}

mode=user
[ "$(id -u)" -eq 0 ] && mode=system
purge=no
yes=no
for arg in "$@"; do
  case "$arg" in
    --user) mode=user ;;
    --system) mode=system ;;
    --purge) purge=yes ;;
    --yes) yes=yes ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if [ "$mode" = system ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Removing the copy for everyone needs root: sudo $0 --system" >&2
    exit 1
  fi
  app=/opt/Libertad
  bin=/usr/local/bin
  menu=/usr/share/applications
else
  data=${XDG_DATA_HOME:-$HOME/.local/share}
  app=$data/Libertad
  bin=$HOME/.local/bin
  menu=$data/applications
fi

found=no
# Only a folder made by install.sh is deleted
if [ -f "$app/.Libertad-install" ]; then
  rm -rf "$app"
  echo "Removed $app"
  found=yes
elif [ -e "$app" ]; then
  echo "$app was not made by install.sh; leaving it alone." >&2
fi
# The command and the menu entry, if they start the removed copy
if [ -f "$bin/Libertad" ] && grep -qF "exec \"$app/Libertad\"" "$bin/Libertad"; then
  rm -f "$bin/Libertad"
  found=yes
fi
if [ -f "$menu/Libertad.desktop" ] && grep -qF "Icon=$app/Libertad.png" "$menu/Libertad.desktop"; then
  rm -f "$menu/Libertad.desktop"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$menu" 2>/dev/null || true
  found=yes
fi
[ "$found" = no ] && echo "No $mode installation of Libertad found."

if [ "$purge" = yes ]; then
  if [ "$(id -u)" -eq 0 ]; then
    echo "Settings belong to each user: run uninstall.sh --purge as yourself, without sudo." >&2
    exit 1
  fi
  config=${XDG_CONFIG_HOME:-$HOME/.config}/Libertad
  if [ ! -d "$config" ]; then
    echo "No settings found in $config"
    exit 0
  fi
  if [ "$yes" != yes ]; then
    echo "This deletes $config: settings, saved servers, kept files and your identities."
    echo "Servers recognize you by your identity; without a backup (.p12) it is gone for good."
    printf 'Type "delete" to go ahead: '
    read -r answer
    if [ "$answer" != delete ]; then
      echo "Kept $config"
      exit 0
    fi
  fi
  rm -rf "$config"
  echo "Removed $config"
else
  echo "Your settings and identities are still in ${XDG_CONFIG_HOME:-$HOME/.config}/Libertad (remove them with --purge)."
fi
