#!/usr/bin/env node
// Create Whitecat org and wire it to Sierra email inbox.
// Usage: OA_DATABASE_URL=... node scripts/create-whitecat-org.mjs

import pg from "pg";
import crypto from "crypto";

const oaUrl = "postgresql://postgres:Databasepassword@1996@db.aiyzpjnvenfmurhyamge.supabase.co:5432/postgres";
const client = new pg.Client({ connectionString: oaUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

const orgId = crypto.randomUUID();
const slug = "whitecat";
const name = "Whitecat";
const email = "info@sierramaterialsco.com";
const inboxId = "599fb464-9682-43cd-8e9e-b5eeff83eb76";

console.log(`Creating Whitecat org...`);
console.log(`  ID: ${orgId}`);
console.log(`  Name: ${name}`);
console.log(`  Slug: ${slug}`);
console.log(`  Email: ${email}`);
console.log(`  Inbox ID: ${inboxId}`);

try {
  const result = await client.query(
    `INSERT INTO public.orgs (id, slug, name, is_internal, tenkara_email_account_id, tenkara_email_address, sourcing_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, slug, name, false, inboxId, email, 'off']
  );

  console.log(`\n✓ Whitecat org created successfully`);
  console.log(`  Sourcing status set to 'off' — flip in Control Room when ready`);

} catch (error) {
  console.error(`✗ Failed to create org: ${error.message}`);
  process.exit(1);
} finally {
  await client.end();
}
