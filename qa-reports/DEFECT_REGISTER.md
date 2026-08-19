# Defect Register & Remediation Log

| Defect ID | Feature | Severity | Root Cause | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DEF-001** | Tool Webhook Execution | **P0** | Expired ngrok URL in .env caused ElevenLabs webhooks to receive 404 ERR_NGROK_3200 | **RESOLVED** | Started live ngrok daemon, updated API_BASE_URL, synced ElevenLabs tools |
| **DEF-002** | Enrollee Registration Tool | **P0** | OnboardingModule missing from AgentToolsModule imports; this.onboarding was undefined | **RESOLVED** | Imported OnboardingModule into AgentToolsModule; live execution returned ok: true |
| **DEF-003** | Equity Zero-Cost Validation | **P1** | !body.amount rejected ₦0 payments as falsy | **RESOLVED** | Updated check to typeof body.amount !== "number"; ₦0 Equity applications accepted |
| **DEF-004** | Agent Welcome Message Test | **P2** | firstMessageFor did not handle plain welcome messages without {name} | **RESOLVED** | Updated firstMessageFor in catalog; test suite passed |
| **DEF-005** | Agent Tool Catalog Spec | **P2** | Test expected 9 tools instead of 10 after adding register-enrollee | **RESOLVED** | Added register-enrollee to tool list in agent-config.spec.ts |
