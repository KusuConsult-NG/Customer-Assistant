# Third-party skills in this folder

Copied from their upstream repositories on 24 November 2026, unmodified except
as noted. Each skill folder carries its upstream LICENSE. To update one, copy
the same folder from a newer upstream commit and update this table.

| Skills | Upstream | Commit | Licence | Needs, when used |
|---|---|---|---|---|
| impeccable | github.com/pbakaus/impeccable (`plugin/skills/impeccable`) | b49177d | Apache-2.0 | Downloads its engine from the author's GitHub releases on first use, checked against `scripts/engine-checksums.txt` |
| claudex-loop, claudex-route, codex-build, codex-review | github.com/chaseai-yt/claudex-loop (`skills/`) | 53cddc4 | MIT | The OpenAI Codex CLI, signed in |
| hyperframes, hyperframes-cli, hyperframes-registry, figma, media-use, remotion-to-hyperframes, reverse-any-video, slideshow, style-sampling | github.com/heygen-com/hyperframes (`skills/`) | ca64f8b | Apache-2.0 | Node; it offers to send HeyGen a usage note before its first command, and skips it if told no |
| last30days | github.com/mvanhorn/last30days-skill (`skills/last30days`) | 7c2e1c2 | MIT | Python 3 and a `SCRAPECREATORS_API_KEY`. Its `assets/` folder (20 MB of README demo images and audio, used by no code) was left out |

Installed as project skills, not as plugins: in the cloud container the plugin
marketplaces declared in `.claude/settings.json` were never cloned
(`~/.claude/plugins/marketplaces` absent), so declared plugins did not load.
As project skills they load from the checkout. Two plugin HOOKS therefore do
not run: impeccable's (its engine after every file edit and at session
start/stop) and last30days' (archiving finished briefs at the end of a turn).
Both skills still work when invoked.
