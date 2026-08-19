# Test Execution Commands

```bash
# 1. Run core unit and integration test suite
cd apps/api && npx jest test/agent-tools.spec.ts test/agent-config.spec.ts test/elevenlabs-contracts.spec.ts test/phone-number.spec.ts test/secret-box.spec.ts test/ssrf.spec.ts test/voice-handoff.spec.ts --runInBand

# 2. Re-sync ElevenLabs Knowledge Base and Remote Tools
node scripts/setup-plaschema.js

# 3. Start development environment with live tunnel
./start-dev.sh
```
