# The Alphatech → ElevenLabs SIP bridge, as a container on the single server.
# Same templates and the same renderer as the native install
# (infra/sip-bridge/render.sh), so the two cannot drift apart.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends asterisk asterisk-core-sounds-en-gsm gettext-base curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY infra/sip-bridge/render.sh infra/sip-bridge/check.sh /opt/bridge/
COPY infra/sip-bridge/templates /opt/bridge/templates
COPY deploy/single-server/bridge/entrypoint.sh /opt/bridge/entrypoint.sh
RUN chmod +x /opt/bridge/*.sh
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD asterisk -rx "core show uptime" >/dev/null || exit 1
ENTRYPOINT ["/opt/bridge/entrypoint.sh"]
