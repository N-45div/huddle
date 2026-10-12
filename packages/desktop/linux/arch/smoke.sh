#!/bin/sh
# Smoke test on a clean Arch: builds huddle-bin from the PKGBUILD with the .deb in /out instead of the
# download, installs it with pacman, runs Huddle on a virtual display and checks its server answers.
# The package (for pacman -U, while it isn't on the AUR) and a screenshot go to /out.
#
#   docker run --rm -v "$PWD/packages/desktop/dist:/out" -v "$PWD/packages/desktop/linux/arch:/pkg:ro" \
#     archlinux:latest sh /pkg/smoke.sh
set -eu
pacman -Syu --noconfirm --needed base-devel xorg-server-xvfb xorg-xauth imagemagick dbus curl >/dev/null
useradd -m builder
mkdir /home/builder/pkg
cp /pkg/PKGBUILD /out/Huddle_*_amd64.deb /home/builder/pkg/
deb=$(basename /out/Huddle_*_amd64.deb)
version=$(echo "$deb" | sed -E 's/^Huddle_(.+)_amd64\.deb$/\1/')
# Build from the local .deb, with its version and real checksum, rather than the release download.
sed -i -e "s|^pkgver=.*|pkgver=${version}|" -e "s|^source=.*|source=(\"${deb}\")|" \
  -e "s|^sha256sums=.*|sha256sums=('$(sha256sum "/out/${deb}" | cut -d' ' -f1)')|" /home/builder/pkg/PKGBUILD
chown -R builder /home/builder/pkg
# Nothing compiles here, so makepkg needn't install the dependencies; pacman -U fetches them from the
# repositories, which also proves each name in depends is a real package.
su builder -c 'cd ~/pkg && makepkg -f -d --noconfirm' >/tmp/makepkg.log 2>&1 || { tail -30 /tmp/makepkg.log; exit 1; }
echo "--- built: $(ls /home/builder/pkg/*.pkg.tar.zst)"
pacman -U --noconfirm /home/builder/pkg/huddle-bin-*.pkg.tar.zst >/tmp/pacman.log 2>&1 || { tail -30 /tmp/pacman.log; exit 1; }
echo "--- installed: $(pacman -Q huddle-bin)"
cp /home/builder/pkg/huddle-bin-*.pkg.tar.zst /out/
echo "--- missing libraries:"; ldd /usr/bin/huddle | grep 'not found' || echo "(none)"
echo "--- icons:"; ls /usr/share/icons/hicolor | tr '\n' ' '; echo
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
cat > /tmp/run.sh <<'EOF'
dbus-launch --exit-with-session sh -c '
  huddle > /tmp/huddle-app.log 2>&1 &
  for i in $(seq 1 60); do curl -s -m 1 http://127.0.0.1:7700/api/info > /tmp/info.json && break; sleep 0.5; done
  sleep 6; import -window root /out/smoke-arch.png
  kill %1 2>/dev/null; sleep 1
'
EOF
xvfb-run -a -s "-screen 0 1280x860x24" sh /tmp/run.sh
echo "--- /api/info"; cat /tmp/info.json; echo
echo "--- the app"; tail -10 /tmp/huddle-app.log || true
echo "--- server starts: $(grep -c 'is on http' /root/.local/share/dev.huddle.desktop/huddle.log) (should be 1)"
