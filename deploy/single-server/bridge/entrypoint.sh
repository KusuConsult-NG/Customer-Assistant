#!/usr/bin/env bash
# Renders the configuration from the container's environment (bridge.env,
# passed by docker compose) and runs Asterisk in the foreground, so a crash
# is a container restart rather than a silent dead line.
set -euo pipefail
/opt/bridge/render.sh /etc/asterisk
chown asterisk:asterisk /etc/asterisk/{pjsip,extensions,rtp,modules}.conf
# Asterisk writes its log to a file and this streams it to the container's
# output, so `docker compose logs bridge` shows registrations and calls.
# Writing to the output directly does not work: Asterisk drops to the
# asterisk user and may not open root's stdout, and console mode (-c) with no
# terminal reads EOF in a loop and floods the log with prompts. Docker
# rotates what reaches its log; the files here are emptied daily.
cat > /etc/asterisk/logger.conf <<'CONF'
[general]
[logfiles]
full => notice,warning,error,verbose(3)
messages => notice,warning,error
CONF
mkdir -p /var/log/asterisk
touch /var/log/asterisk/full /var/log/asterisk/messages
chown -R asterisk:asterisk /var/log/asterisk
tail -n0 -F /var/log/asterisk/full &
( while sleep 86400; do : > /var/log/asterisk/full; : > /var/log/asterisk/messages; done ) &
echo "==> Bridge starting. In ElevenLabs, this server's public IP must be in the phone number's allowed addresses."
exec asterisk -f -U asterisk -G asterisk -vvv
