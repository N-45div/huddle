#!/bin/sh
# Smoke test on a clean Ubuntu: installs the .deb from /out, runs Huddle on a virtual display, checks its
# server answers and its window shows the opening screen, then the canvas; screenshots go to /out.
#
#   docker run --rm -v "$PWD/packages/desktop/dist:/out" ubuntu:24.04 sh /out/smoke.sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq /out/Huddle_*_amd64.deb xvfb xauth imagemagick dbus-x11 curl >/dev/null
# Software rendering: containers have no GPU.
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
cat > /tmp/run.sh <<'EOF'
dbus-launch --exit-with-session sh -c '
  huddle > /tmp/huddle-app.log 2>&1 &
  sleep 1.2; import -window root /out/smoke-opening.png
  for i in $(seq 1 60); do curl -s -m 1 http://127.0.0.1:7700/api/info > /tmp/info.json && break; sleep 0.5; done
  sleep 6; import -window root /out/smoke-canvas.png
  kill %1 2>/dev/null; sleep 1
'
EOF
xvfb-run -a -s "-screen 0 1280x860x24" sh /tmp/run.sh
echo "--- /api/info"; cat /tmp/info.json; echo
echo "--- the app"; tail -20 /tmp/huddle-app.log || true
echo "--- the server's log"; tail -20 /root/.local/share/dev.huddle.desktop/huddle.log || true
echo "--- server starts: $(grep -c 'is on http' /root/.local/share/dev.huddle.desktop/huddle.log) (should be 1)"
echo "--- start at login"; cat /root/.config/autostart/*.desktop 2>/dev/null || echo "(no autostart entry)"
echo "--- keys file"; ls -l /root/.config/dev.huddle.desktop/
