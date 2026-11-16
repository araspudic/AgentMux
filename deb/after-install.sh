#!/bin/bash
# postinst for the AgentMux .deb

# /usr/bin/agentmux
if type update-alternatives >/dev/null 2>&1; then
    if [ -L /usr/bin/agentmux ] && [ -e /usr/bin/agentmux ] && [ "$(readlink /usr/bin/agentmux)" != /etc/alternatives/agentmux ]; then
        rm -f /usr/bin/agentmux
    fi
    update-alternatives --install /usr/bin/agentmux agentmux /opt/AgentMux/agentmux 100 || ln -sf /opt/AgentMux/agentmux /usr/bin/agentmux
else
    ln -sf /opt/AgentMux/agentmux /usr/bin/agentmux
fi

# Electron's sandbox needs unprivileged user namespaces. Ubuntu 23.10+ only allows them for
# programs with an AppArmor profile granting "userns" (the same approach Ubuntu uses for Chrome
# and VS Code). Install one; if that's not possible, fall back to the setuid sandbox helper.
profile_ok=0
if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1 && [ -e /etc/apparmor.d/abi/4.0 ]; then
    cat > /etc/apparmor.d/agentmux <<'EOF'
# AgentMux (Electron): allow the Chromium sandbox to create user namespaces
abi <abi/4.0>,
include <tunables/global>

profile agentmux /opt/AgentMux/agentmux flags=(unconfined) {
  userns,

  include if exists <local/agentmux>
}
EOF
    if apparmor_parser -r -T -W /etc/apparmor.d/agentmux >/dev/null 2>&1; then
        profile_ok=1
    fi
fi
if [ "$profile_ok" = 1 ]; then
    chmod 0755 /opt/AgentMux/chrome-sandbox || true
else
    chmod 4755 /opt/AgentMux/chrome-sandbox || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
exit 0
