# Changelog — QA Fixes & Hardening

- **fix(agent-tools)**: Added OnboardingModule to AgentToolsModule imports to resolve missing requestSelfie dependency.
- **fix(payment)**: Allowed 0 amount in PublicPaymentController.confirm to support ₦0 Equity applications.
- **feat(facilities)**: Created plaschema-facilities.ts with 17 Plateau LGAs directory and facility resolution logic.
- **feat(equity)**: Implemented ₦0 Equity plan selector and CRM verification queue.
- **fix(tunnel)**: Created start-dev.sh for automatic ngrok detection, .env patching, and ElevenLabs syncing.
- **test(specs)**: Updated agent-config.spec.ts to include all 10 agent tools and system prompt assertions.
