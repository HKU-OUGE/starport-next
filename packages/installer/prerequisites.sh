#!/bin/sh
# Invoked by pkexec: no password is read by Starport.
set -eu
[ "$(id -u)" = 0 ] || exit 10
[ $# = 3 ] || exit 11
user=$1
workspace=$2
seamless=$3
case "$user" in ''|*[!a-zA-Z0-9_.-]*) exit 12;; esac
case "$workspace:$seamless" in 0:0|1:0|1:1) ;; *) exit 13;; esac
command -v apt-get >/dev/null || exit 14
apt-get update
if [ "$workspace" = 1 ]; then
  apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils openssh-client curl ca-certificates bubblewrap sshfs zenity xdg-utils
  if getent group kvm >/dev/null; then usermod -aG kvm -- "$user"; fi
else
  apt-get install -y --no-install-recommends openssh-client ca-certificates xdg-utils
fi
if [ "$seamless" = 1 ]; then apt-get install -y --no-install-recommends xpra xvfb xauth python3-pil; fi
