# TEST EXECUTION COMMANDS & QA RUNBOOK

**Application:** PLASCHEMA Customer Assistant  
**Repository:** `/Users/mac/Customer Assistance`  

---

## 1. Quick System Health & Process Status
```bash
# Check PM2 processes
pm2 status

# Check PostgreSQL connection & database records
cd "/Users/mac/Customer Assistance/apps/api" && node -e '
require("dotenv").config({ path: ".env" });
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
p.organization.count().then(c => { console.log("Organizations:", c); process.exit(0); });
'

# Check Redis connection
redis-cli ping
```

---

## 2. Security Probes & Verification Suite
```bash
cd "/Users/mac/Customer Assistance/apps/api" && node -e '
require("dotenv").config({ path: ".env" });
(async () => {
  const BASE = "http://localhost:4000";
  // 1. Check health
  const h = await fetch(BASE + "/api/health").then(r => r.json());
  console.log("Health:", h.status);
  
  // 2. Test login
  const login = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@acedemo.com", password: "Admin@2030!" })
  }).then(r => r.json());
  console.log("Auth:", login.accessToken ? "SUCCESS" : "FAILED");
})();
'
```

---

## 3. Mandatory Business Journey Suite (10 E2E Workflows)
```bash
cd "/Users/mac/Customer Assistance/apps/api" && node -e '
require("dotenv").config({ path: ".env" });
(async () => {
  const BASE = "http://localhost:4000";
  const { accessToken: token } = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ email: "admin@acedemo.com", password: "Admin@2030!" })
  }).then(r => r.json());
  const auth = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

  // TEST 01: FAQ Search
  const faqs = await fetch(BASE + "/api/knowledge/faqs", { headers: auth }).then(r => r.json());
  console.log("TEST 01 (Knowledge FAQs):", faqs.length > 0 ? "PASS ✅" : "FAIL ❌");

  // TEST 03: Payment Guidance
  const pay = await fetch(BASE + "/api/billing/service-payment-guidance", {
    method: "POST", headers: auth,
    body: JSON.stringify({ serviceName: "PLASCHEMA Premium Plan", amountNgn: 15000 })
  }).then(r => r.json());
  console.log("TEST 03 (Payment Guidance):", pay.formattedAmount ? "PASS ✅" : "FAIL ❌");

  // TEST 06: Widget Deprecation
  const w = await fetch(BASE + "/api/widget/chat");
  console.log("TEST 06 (Widget 410):", w.status === 410 ? "PASS ✅" : "FAIL ❌");

  // TEST 07: Human Handoff
  const convs = await fetch(BASE + "/api/conversations", { headers: auth }).then(r => r.json());
  if (convs[0]) {
    const hand = await fetch(BASE + "/api/conversations/" + convs[0].id + "/handoff", {
      method: "PATCH", headers: auth, body: JSON.stringify({ handoff: true })
    }).then(r => r.json());
    console.log("TEST 07 (Handoff Toggle):", hand.isHumanHandoffActive === true ? "PASS ✅" : "FAIL ❌");
    await fetch(BASE + "/api/conversations/" + convs[0].id + "/handoff", {
      method: "PATCH", headers: auth, body: JSON.stringify({ handoff: false })
    });
  }
})();
'
```

---

## 4. Performance & Load Benchmarks
```bash
cd "/Users/mac/Customer Assistance/apps/api" && node -e '
require("dotenv").config({ path: ".env" });
const http = require("http");

async function benchmark(url, headers = {}, total = 50) {
  const parsed = new URL(url);
  const latencies = [];
  const start = Date.now();
  for (let i = 0; i < total; i++) {
    const s = Date.now();
    await new Promise(res => {
      const req = http.request({
        hostname: parsed.hostname, port: parsed.port || 80,
        path: parsed.pathname + parsed.search, method: "GET", headers
      }, (r) => { r.on("data", ()=>{}); r.on("end", ()=>{ latencies.push(Date.now()-s); res(); }); });
      req.end();
    });
  }
  const avg = Math.round(latencies.reduce((a,b)=>a+b, 0) / latencies.length);
  console.log(`URL: ${url} | Total: ${total} | Avg Latency: ${avg}ms | Min: ${Math.min(...latencies)}ms | Max: ${Math.max(...latencies)}ms`);
}

(async () => {
  await benchmark("http://localhost:4000/api/health", {}, 100);
})();
'
```

---

## 5. Playwright Frontend E2E Tests
```bash
cd "/Users/mac/Customer Assistance/apps/web" && npx playwright test --reporter=list
```
