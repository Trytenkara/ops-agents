import pg from 'pg';
const cs = `postgresql://postgres.aiyzpjnvenfmurhyamge:${encodeURIComponent(process.env.OA_SUPABASE_DB_PASSWORD)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`;
const M='4d225c43-9d60-426f-8769-07d26f8bcb84';
for (let i=0;i<14;i++){
  const c = new pg.Client({ connectionString: cs, ssl:{rejectUnauthorized:false} });
  await c.connect();
  const ev = await c.query(`select at, level, step, message, data::text as d from agent_run_events where at > '2026-08-11T03:00:00Z' and data::text like '%'||$1||'%' order by at`,[M]);
  const al = await c.query(`select value::text v from agent_state where key='material_aliases:'||$1`,[M]);
  const n = await c.query(`select source, count(*) from leads_in_flight where material_id=$1 group by 1`,[M]);
  if (ev.rows.length) {
    for (const r of ev.rows) console.log(r.at.toISOString().slice(11,19), `[${r.level}/${r.step}]`, String(r.message).slice(0,200), (r.d&&r.d!=='null')?r.d.slice(0,220):'');
    if (al.rows.length) console.log('ALIASES:', al.rows[0].v.slice(0,300));
    console.table(n.rows);
    const done = ev.rows.some(r=>r.step==='importyeti');
    await c.end();
    if (done) process.exit(0);
  } else { await c.end(); }
  await new Promise(r=>setTimeout(r,60000));
}
console.log('no sunflower pass seen yet');
