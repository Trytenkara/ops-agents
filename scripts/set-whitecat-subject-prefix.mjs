#!/usr/bin/env node
// Set Whitecat's subject prefix to [WC].
// Run after migration 0117_org_subject_prefix.sql is applied.
// Usage: node scripts/set-whitecat-subject-prefix.mjs

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  console.error("Need SUPABASE_SERVICE_ROLE_KEY env var");
  process.exit(1);
}

const url = "https://aiyzpjnvenfmurhyamge.supabase.co/rest/v1/orgs?slug=eq.whitecat";

fetch(url, {
  method: "PATCH",
  headers: {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ subject_prefix: "[WC]" }),
})
  .then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  })
  .then((data) => {
    console.log("✓ Whitecat subject_prefix set to [WC]");
    console.log(JSON.stringify(data, null, 2));
  })
  .catch((e) => {
    console.error("✗", e.message);
    process.exit(1);
  });
