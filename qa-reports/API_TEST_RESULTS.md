# API Test Results

| Endpoint | Method | Status | Result |
| :--- | :--- | :--- | :--- |
| /api/auth/login | POST | 201 | JWT access & refresh tokens issued |
| /api/crm/contacts | GET | 200 | Returns CRM contacts list |
| /api/public/pay/lookup | POST | 201 | Resolves enrollee by phone/reference |
| /api/public/pay/confirm | POST | 201 | Confirms premium / ₦0 equity application |
| /api/crm/contacts/:id/digital-card | GET | 200 | Returns complete printable HTML card |
| /api/crm/contacts/:id/approve-enrollee | POST | 201 | Enrollee approved & activated |
| /api/analytics/dashboard | GET | 200 | Live metrics returned |
| /api/agent-tools/register-enrollee | POST | 200 | On-call enrollment record created |
| /api/agent-tools/create-ticket | POST | 200 | Ticket created with QA escalation |
