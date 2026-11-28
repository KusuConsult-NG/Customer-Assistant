Recorded prompts for the call bridge (8 kHz mono 16-bit WAV, or GSM).

A file here, e.g. `governor-welcome.wav`, is played by setting in
`infra/sip-bridge/bridge.env`:

    INTRO_SOUND=/opt/bridge/sounds/governor-welcome

(the full path, without the extension). Empty: nothing is played before the
assistant answers.

## The waiting room (every line busy)

`queue-hold`, `queue-still`, `queue-callback`, `queue-later` and `queue-tone`
are what a caller hears while waiting for a free line (the dialplan's
`[queue]`). They are spoken by the line's own assistant voice and made on the
server, where the voice key is (see `apps/api/src/voice-local/queue-sounds.ts`):

    cd /opt/customer-assistant/deploy/single-server
    for s in hold still callback later tone; do
      sudo docker compose --env-file server.env -f docker-compose.yml exec -T api node apps/api/dist/voice-local/queue-sounds.js $s > bridge/sounds/queue-$s.wav
    done

Until they exist, Asterisk's own English prompts are played instead
(`pls-hold-while-try`, `queue-periodic-announce`, `queue-thankyou`), so the
waiting room works without them. They are not kept in git. Then check none
is empty (`ls -l bridge/sounds/queue-*.wav`; delete any of 0 bytes) and restart
the bridge:

    sudo docker compose --env-file server.env -f docker-compose.yml --profile bridge restart bridge
