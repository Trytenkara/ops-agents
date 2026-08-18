import { createClient } from "@supabase/supabase-js";
import { truncationGuardedFetch } from "./src/lib/supabase/truncation-guard";
import { selectAllPaged } from "./src/lib/supabase-paging";

const url = "https://aiyzpjnvenfmurhyamge.supabase.co";
const key = process.env.OA_SUPABASE_SERVICE_ROLE_KEY!;
const guarded = createClient(url, key, { global: { fetch: truncationGuardedFetch() } });
const plain = createClient(url, key);

const { data: raw } = await plain.from("leads_in_flight").select("id");
console.log("UNGUARDED unbounded read returned:", raw?.length, "rows (no error reported)");

try {
  await guarded.from("leads_in_flight").select("id");
  console.log("GUARDED unbounded read: NO THROW (bad if table > 1000)");
} catch (e: any) {
  console.log("GUARDED unbounded read THREW:", e.message.slice(0, 140));
}

const paged = await selectAllPaged<{ id: string }>((f, t) =>
  guarded.from("leads_in_flight").select("id").order("id").range(f, t)
);
console.log("GUARDED paged read returned:", paged.length, "rows, no throw");

const { data: one } = await guarded.from("leads_in_flight").select("id").limit(5);
console.log("GUARDED bounded .limit(5):", one?.length, "rows, no throw");
