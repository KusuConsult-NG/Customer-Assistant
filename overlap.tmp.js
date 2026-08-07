const fs=require('fs');const env={};
for(const l of fs.readFileSync('.env','utf8').split('\n')){const t=l.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i<0)continue;env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
Object.assign(process.env,env);
const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{
  const rows=await p.$queryRawUnsafe(`
    SELECT a."organizationId", a."staffName", a."serviceName" AS sa, b."serviceName" AS sb,
           a."startTime" AS astart, a."endTime" AS aend, b."startTime" AS bstart, b."endTime" AS bend,
           a."createdAt" AS acreated, b."createdAt" AS bcreated
    FROM bookings a JOIN bookings b
      ON a."organizationId"=b."organizationId" AND a."staffName"=b."staffName" AND a.id<b.id
     AND a."startTime" < b."endTime" AND a."endTime" > b."startTime"
    WHERE a.status IN ('CONFIRMED','RESCHEDULED') AND b.status IN ('CONFIRMED','RESCHEDULED')
      AND a."staffName" IS NOT NULL
    LIMIT 5`);
  console.log('sample overlapping pairs:');
  for(const r of rows){
    console.log(`  org=${r.organizationId.slice(0,8)} staff=${r.staffName}`);
    console.log(`    A "${r.sa}" ${r.astart.toISOString()} → ${r.aend.toISOString()} (created ${r.acreated.toISOString()})`);
    console.log(`    B "${r.sb}" ${r.bstart.toISOString()} → ${r.bend.toISOString()} (created ${r.bcreated.toISOString()})`);
  }
  const byStaff=await p.$queryRawUnsafe(`
    SELECT a."staffName", COUNT(*)::int n FROM bookings a JOIN bookings b
      ON a."organizationId"=b."organizationId" AND a."staffName"=b."staffName" AND a.id<b.id
     AND a."startTime" < b."endTime" AND a."endTime" > b."startTime"
    WHERE a.status IN ('CONFIRMED','RESCHEDULED') AND b.status IN ('CONFIRMED','RESCHEDULED') AND a."staffName" IS NOT NULL
    GROUP BY 1 ORDER BY n DESC`);
  console.log('\nby staff:', byStaff.map(r=>`${r.staffName}=${r.n}`).join(', '));
  await p.$disconnect();
})();
