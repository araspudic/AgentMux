#!/bin/bash
# postrm for the AgentMux .deb (only clean up on real removal, not on upgrade)
case "$1" in
    remove|purge)
        if type update-alternatives >/dev/null 2>&1; then
            update-alternatives --remove agentmux /opt/AgentMux/agentmux >/dev/null 2>&1 || true
        fi
        rm -f /usr/bin/agentmux
        if [ -f /etc/apparmor.d/agentmux ]; then
            apparmor_parser -R /etc/apparmor.d/agentmux >/dev/null 2>&1 || true
            rm -f /etc/apparmor.d/agentmux
        fi
        ;;
esac
exit 0
