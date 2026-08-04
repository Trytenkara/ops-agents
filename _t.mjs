import pg from "pg";
const c=new pg.Client({host:"aws-1-us-west-2.pooler.supabase.com",port:5432,user:"postgres.aiyzpjnvenfmurhyamge",password:process.env.OA_SUPABASE_DB_PASSWORD,database:"postgres",ssl:{rejectUnauthorized:false}});
await c.connect();
const r=await c.query("select distinct thread_id from draft_references where email_client='rod_app' and thread_id is not null and supplier_id is not null and created_at > now() - interval '90 days'");
await c.end();
const tok=process.env.TENKARA_API_TOKEN;
let empty=0, withMsgs=0, miss=0, hist=[];
for (const {thread_id} of r.rows){
  const res=await fetch(`https://tenkara-inbox-nine.vercel.app/api/external/conversations/${thread_id}`,{headers:{Authorization:`Bearer ${tok}`}});
  if(!res.ok){miss++;continue;}
  const d=await res.json();
  const n=(d.messages||[]).length;
  if(n===0) empty++; else {withMsgs++; hist.push(n);}
}
console.log({total:r.rows.length, empty, withMsgs, miss, msgCounts:hist.sort((a,b)=>a-b)});
