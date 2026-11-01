#!/usr/bin/env bash
# Installs the Bridge agent on any Linux distribution (Ubuntu/Debian/Mint/Pop!_OS, Fedora/RHEL, Arch/Manjaro, openSUSE).
#   ./install.sh            install dependencies, the agent and a systemd service
#   ./install.sh --uninstall
set -euo pipefail

APP_DIR="${HOME}/.local/opt/bridge"
BIN_DIR="${HOME}/.local/bin"
UNIT_DIR="${HOME}/.config/systemd/user"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # pc-agent

# Before the rename the product was "TahaBLT Connect": remove that install (pairings move with the agent's data)
remove_old_install() {
  systemctl --user disable --now tahablt-connect.service 2>/dev/null || true
  rm -f "${UNIT_DIR}/tahablt-connect.service" "${BIN_DIR}/tahablt-connect"
  sudo -n rm -f /usr/local/bin/tahablt-connect 2>/dev/null || true
  rm -rf "${HOME}/.local/opt/tahablt-connect"
}

if [[ "${1:-}" == "--uninstall" ]]; then
  remove_old_install
  systemctl --user disable --now bridge-agent.service 2>/dev/null || true
  rm -f "${UNIT_DIR}/bridge-agent.service" "${BIN_DIR}/bridgectl"
  rm -f "${HOME}/.local/share/icons/hicolor/scalable/apps/bridge.svg" "${HOME}/.local/share/icons/hicolor/256x256/apps/bridge.png" 2>/dev/null || true
  rm -f "${HOME}/.local/share/applications/bridge.desktop" 2>/dev/null || true
  sudo rm -f /usr/local/bin/bridgectl 2>/dev/null || true
  rm -rf "${APP_DIR}"
  systemctl --user daemon-reload || true
  echo "Kaldırıldı. Ayarlar ~/.local/share/bridge içinde duruyor."
  exit 0
fi

need=(node xdotool wmctrl xrandr xset xclip pactl playerctl ffmpeg)
if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]] || [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
  need+=(wl-copy ydotool wtype grim)
fi
missing=()
for tool in "${need[@]}"; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done

if ((${#missing[@]})); then
  echo "Eksik araçlar kuruluyor: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y || true
    sudo apt-get install -y nodejs xdotool wmctrl x11-xserver-utils x11-utils xclip pulseaudio-utils playerctl ffmpeg brightnessctl libnotify-bin ethtool curl xz-utils || true
    sudo apt-get install -y wl-clipboard ydotool wtype grim slurp wlr-randr wf-recorder gnome-screenshot ddcutil 2>/dev/null || true
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs xdotool wmctrl xrandr xset xprop xclip pulseaudio-utils playerctl ffmpeg brightnessctl libnotify ethtool curl xz || true
    sudo dnf install -y wl-clipboard ydotool wtype grim slurp wlr-randr wf-recorder ddcutil 2>/dev/null || true
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --needed --noconfirm nodejs xdotool wmctrl xorg-xrandr xorg-xset xorg-xprop xclip libpulse playerctl ffmpeg brightnessctl libnotify ethtool curl xz || true
    sudo pacman -Sy --needed --noconfirm wl-clipboard ydotool wtype grim slurp wlr-randr wf-recorder ddcutil 2>/dev/null || true
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper --non-interactive install nodejs xdotool wmctrl xrandr xset xprop xclip pulseaudio-utils playerctl ffmpeg brightnessctl libnotify-tools ethtool curl xz || true
    sudo zypper --non-interactive install wl-clipboard ydotool wtype grim slurp wlr-randr wf-recorder ddcutil 2>/dev/null || true
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add --no-cache nodejs npm xdotool wmctrl xrandr xset xprop xclip pulseaudio-utils playerctl ffmpeg brightnessctl libnotify ethtool curl xz wl-clipboard grim slurp wtype ydotool 2>/dev/null || true
  else
    echo "Uyarı: Paket yöneticisi otomatik tanınmadı; eksik araçları (${missing[*]}) paket yöneticinizle kurabilirsiniz." >&2
  fi
fi

# Grant user access to /dev/uinput so Wayland input tools (ydotool / dotool) work without root prompts
if [[ -e /dev/uinput ]] && [[ -n "${USER:-}" ]]; then
  sudo usermod -aG input "${USER}" 2>/dev/null || true
  if [[ -d /etc/udev/rules.d ]]; then
    echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/80-bridge-uinput.rules >/dev/null 2>&1 || true
    sudo udevadm control --reload-rules 2>/dev/null || true
    sudo udevadm trigger /dev/uinput 2>/dev/null || true
  fi
fi

mkdir -p "${APP_DIR}" "${BIN_DIR}" "${UNIT_DIR}"
remove_old_install
# Only what the Linux agent runs: from a git checkout pc-agent/ also holds Windows binaries and build scripts
cp "${SRC_DIR}/server.js" "${SRC_DIR}/package.json" "${APP_DIR}/"
[[ -f "${SRC_DIR}/package-lock.json" ]] && cp "${SRC_DIR}/package-lock.json" "${APP_DIR}/"
mkdir -p "${APP_DIR}/linux"
cp "${SRC_DIR}"/linux/*.js "${SRC_DIR}/linux/install.sh" "${SRC_DIR}/linux/bridge-agent.service" "${APP_DIR}/linux/"
for icon_f in bridge-icon.svg bridge-icon.png; do
  [[ -f "${SRC_DIR}/linux/${icon_f}" ]] && cp "${SRC_DIR}/linux/${icon_f}" "${APP_DIR}/linux/"
done
if [[ -f "${APP_DIR}/linux/bridge-icon.svg" ]]; then
  mkdir -p "${HOME}/.local/share/icons/hicolor/scalable/apps"
  cp "${APP_DIR}/linux/bridge-icon.svg" "${HOME}/.local/share/icons/hicolor/scalable/apps/bridge.svg"
fi
if [[ -f "${APP_DIR}/linux/bridge-icon.png" ]]; then
  mkdir -p "${HOME}/.local/share/icons/hicolor/256x256/apps"
  cp "${APP_DIR}/linux/bridge-icon.png" "${HOME}/.local/share/icons/hicolor/256x256/apps/bridge.png"
fi
rm -f "${APP_DIR}/linux/build-package.js"
[[ -x "${SRC_DIR}/linux/cloudflared" ]] && cp "${SRC_DIR}/linux/cloudflared" "${APP_DIR}/linux/"
[[ -d "${SRC_DIR}/node_modules/ws" ]] && { mkdir -p "${APP_DIR}/node_modules"; cp -r "${SRC_DIR}/node_modules/ws" "${APP_DIR}/node_modules/"; }

# Resolve Node.js >= 18 (if system node is missing or older than v18, download standalone Node 20 LTS automatically)
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if ((node_major >= 18)); then
    NODE_BIN="$(command -v node)"
  fi
fi

if [[ -z "${NODE_BIN}" ]]; then
  if [[ -x "${APP_DIR}/linux/node-runtime/bin/node" ]]; then
    NODE_BIN="${APP_DIR}/linux/node-runtime/bin/node"
  else
    arch="$(uname -m)"
    case "$arch" in
      x86_64) node_arch="x64" ;;
      aarch64|arm64) node_arch="arm64" ;;
      armv7l) node_arch="armv7l" ;;
      *) node_arch="" ;;
    esac
    if [[ -n "$node_arch" ]]; then
      NODE_VER="v20.18.1"
      echo "Sistemde Node.js 18+ bulunamadı; taşınabilir Node.js ${NODE_VER} (${node_arch}) indiriliyor..."
      tmp_tar="$(mktemp /tmp/bridge-node-XXXXXX.tar.xz)"
      if curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${node_arch}.tar.xz" -o "$tmp_tar"; then
        mkdir -p "${APP_DIR}/linux/node-runtime"
        tar -xJf "$tmp_tar" -C "${APP_DIR}/linux/node-runtime" --strip-components=1
        rm -f "$tmp_tar"
        NODE_BIN="${APP_DIR}/linux/node-runtime/bin/node"
      else
        rm -f "$tmp_tar"
        echo "Node.js 18+ indirilemedi. Lütfen Node.js 18 veya üstünü kurun." >&2
        exit 1
      fi
    else
      echo "Node.js 18 veya üstü gerekli." >&2
      exit 1
    fi
  fi
fi

if [[ "${XDG_SESSION_TYPE:-x11}" == "wayland" ]] || [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
  echo "Bilgi: Wayland oturumu algılandı (${XDG_CURRENT_DESKTOP:-Wayland}). Wayland ve X11 uyumluluk katmanı etkinleştirildi."
fi

# Cloudflare tunnel for mobile data (optional; LAN works without it)
if ! command -v cloudflared >/dev/null 2>&1 && [[ ! -x "${APP_DIR}/linux/cloudflared" ]]; then
  arch="$(uname -m)"; case "$arch" in x86_64) cf=amd64 ;; aarch64|arm64) cf=arm64 ;; armv7l) cf=arm ;; *) cf="" ;; esac
  if [[ -n "$cf" ]]; then
    echo "cloudflared indiriliyor (mobil veri tüneli için)..."
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf}" -o "${APP_DIR}/linux/cloudflared" \
      && chmod +x "${APP_DIR}/linux/cloudflared" || echo "cloudflared indirilemedi; yalnızca yerel ağ kullanılacak."
  fi
fi

# Install npm dependencies only if node_modules/ws is not already bundled in the archive
if [[ ! -d "${APP_DIR}/node_modules/ws" ]]; then
  NPM_BIN="$(dirname "${NODE_BIN}")/npm"
  if [[ -x "${NPM_BIN}" ]]; then
    (cd "${APP_DIR}" && "${NPM_BIN}" install --omit=dev --no-audit --no-fund >/dev/null)
  elif command -v npm >/dev/null 2>&1; then
    (cd "${APP_DIR}" && npm install --omit=dev --no-audit --no-fund >/dev/null)
  fi
fi

chmod +x "${APP_DIR}/linux/install.sh" "${APP_DIR}/linux/bridgectl.js" 2>/dev/null || true

cat > "${BIN_DIR}/bridgectl" <<EOF
#!/usr/bin/env bash
exec "${NODE_BIN}" "${APP_DIR}/linux/bridgectl.js" "\$@"
EOF
chmod +x "${BIN_DIR}/bridgectl"

# Install desktop launcher entry so the Bridge 10B logo appears in the Linux Application Menu / Dock
mkdir -p "${HOME}/.local/share/applications"
cat > "${HOME}/.local/share/applications/bridge.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Bridge
GenericName=Uzaktan Masaüstü ve İş İstasyonu
Comment=30 saniyelik eşleştirme kodu oluşturur ve panoya kopyalar
Exec=${BIN_DIR}/bridgectl pair
Icon=${APP_DIR}/linux/bridge-icon.svg
Terminal=false
Categories=Utility;Network;RemoteAccess;
StartupNotify=false
Actions=Pair;Disconnect;Restart;

[Desktop Action Pair]
Name=Bağlantı Kur (30 sn Kod Oluştur)
Exec=${BIN_DIR}/bridgectl pair

[Desktop Action Disconnect]
Name=Tüm Bağlantıları Kes
Exec=${BIN_DIR}/bridgectl disconnect

[Desktop Action Restart]
Name=Servisi Yeniden Başlat
Exec=${BIN_DIR}/bridgectl restart
EOF
chmod +x "${HOME}/.local/share/applications/bridge.desktop" 2>/dev/null || true

# Also link into /usr/local/bin if sudo is available so `bridgectl` works even when ~/.local/bin is not in PATH
if [[ -d /usr/local/bin ]]; then
  sudo ln -sf "${BIN_DIR}/bridgectl" /usr/local/bin/bridgectl 2>/dev/null || true
fi

# Ensure ~/.local/bin is in user shell RC files
for rc in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
  if [[ -f "$rc" ]] && ! grep -q '\.local/bin' "$rc" 2>/dev/null; then
    printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
  fi
done

sed -e "s|@APP_DIR@|${APP_DIR}|g" -e "s|@NODE_BIN@|${NODE_BIN}|g" "${APP_DIR}/linux/bridge-agent.service" > "${UNIT_DIR}/bridge-agent.service"
systemctl --user daemon-reload || true
# Not every desktop exports the display to the user manager; import both X11 and Wayland/compositor variables
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP DESKTOP_SESSION HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK I3SOCK DBUS_SESSION_BUS_ADDRESS 2>/dev/null || true
systemctl --user enable --now bridge-agent.service || true

# Enable systemd user linger so the service starts at boot even before login
if command -v loginctl >/dev/null 2>&1 && [[ -n "${USER:-}" ]]; then
  sudo loginctl enable-linger "${USER}" 2>/dev/null || loginctl enable-linger "${USER}" 2>/dev/null || true
fi

# Enable Wake-on-LAN (Magic Packet 'g') on active physical Ethernet interfaces
if command -v ethtool >/dev/null 2>&1; then
  for netdev in /sys/class/net/*; do
    ifname="$(basename "$netdev")"
    if [[ "$ifname" =~ ^(eth|en|eno|enp|ens) ]]; then
      sudo ethtool -s "$ifname" wol g 2>/dev/null || true
    fi
  done
fi

# Allow phones on the local network (ufw / firewalld when present)
if command -v ufw >/dev/null 2>&1; then sudo ufw allow 4850/tcp 2>/dev/null && sudo ufw allow 4851/udp 2>/dev/null || true; fi
if command -v firewall-cmd >/dev/null 2>&1; then
  sudo firewall-cmd --permanent --add-port=4850/tcp --add-port=4851/udp 2>/dev/null && sudo firewall-cmd --reload 2>/dev/null || true
fi

echo ""
echo "✓ Bridge başarıyla kuruldu ve başlatıldı!"
echo "  Eşleştirme kodu almak için:  bridgectl pair"
echo "  Durumu görmek için        :  bridgectl status"
echo "  Eşli cihazları görmek için:  bridgectl devices"
