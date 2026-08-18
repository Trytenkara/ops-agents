import { createClient } from '@supabase/supabase-js';

const url = 'https://zuhwxqiqatitodvjapwq.supabase.co';
const key = process.env.TENKARA_READONLY_KEY;

if (!key) {
  console.error('TENKARA_READONLY_KEY not set');
  process.exit(1);
}

const client = createClient(url, key);

const badQuoteIds = [
  'bdd35c7f-f3d5-4946-9938-c5aea0ff8c8d',  // $999k
  '7a398ad6-aada-438c-9f0e-4bf545f3561a',  // conversion broken
  '5ec3d620-c441-4c4f-90a6-f0246d94f599'   // TOO_CHEAP
];

const { data, error } = await client
  .from('material_quotes')
  .select('*')
  .in('id', badQuoteIds);

if (error) {
  console.error('Error:', error);
  process.exit(1);
}

console.log(`Found ${data.length} quotes:\n`);
for (const quote of data) {
  console.log(`ID: ${quote.id}`);
  console.log(`  Supplier ID: ${quote.supplier_id}`);
  console.log(`  Material ID: ${quote.material_id}`);
  console.log(`  Price: $${quote.price} / ${quote.case_size} ${quote.unit_of_measurement}`);
  console.log(`  Created: ${quote.created_at}`);
  console.log(`  Created by: ${quote.created_by}`);
  console.log(`  Source type: ${quote.source_type || 'N/A'}`);
  console.log();
}
