import { createAdminClient } from "../src/lib/supabase/admin";
import { runThreadReconcile } from "../src/agents-runtime/agents/reply-manager/thread-reconcile";
const a = createAdminClient();
const r = await runThreadReconcile({ agentId:"", runId:"", log: async ()=>{} }, a);
console.log(JSON.stringify(r));
