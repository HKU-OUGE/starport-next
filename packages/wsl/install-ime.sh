#!/bin/bash
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LANG=C.UTF-8 TZ=Asia/Taipei DEBIAN_FRONTEND=noninteractive
export HTTPS_PROXY="${STARPORT_INSTALL_PROXY:?controlled installer proxy required}" HTTP_PROXY="$STARPORT_INSTALL_PROXY"
export https_proxy="$HTTPS_PROXY" http_proxy="$HTTP_PROXY" NO_PROXY=localhost,127.0.0.1
apt_options=(-o "Acquire::https::Proxy=$HTTPS_PROXY" -o "Acquire::http::Proxy=$HTTP_PROXY" -o Acquire::Retries=2 -o Acquire::https::Timeout=45)
apt-get "${apt_options[@]}" update -qq
apt-get "${apt_options[@]}" install -y --no-install-recommends fcitx5 fcitx5-rime fcitx5-frontend-gtk2 fcitx5-frontend-gtk3 fcitx5-frontend-qt5 rime-data-luna-pinyin libglib2.0-bin fonts-noto-cjk
# Packages and dictionaries are shared read-only; daemons run per project only.
dpkg-query -W fcitx5 fcitx5-rime rime-data-luna-pinyin
