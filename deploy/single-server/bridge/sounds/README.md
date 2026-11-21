Recorded prompts for the call bridge (8 kHz mono 16-bit WAV, or GSM).

A file here, e.g. `governor-welcome.wav`, is played by setting in
`infra/sip-bridge/bridge.env`:

    INTRO_SOUND=/opt/bridge/sounds/governor-welcome

(the full path, without the extension). Empty: nothing is played before the
assistant answers.
