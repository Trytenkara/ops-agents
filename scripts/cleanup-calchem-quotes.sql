-- CalChem Quote Data Cleanup
-- 2026-08-18
-- Fixes: Delete $999k entries, backfill densities for volume quotes

-- 1. DELETE extreme outliers ($999,999 entries)
DELETE FROM material_quotes 
WHERE id IN (
  'bdd35c7f-f3d5-4946-9938-c5aea0ff8c8d',
  '5e992bc0-c088-4cfd-923a-4f1237e51f6b'
)
AND price = 999999.99
AND case_size = 4400;

-- Verify deletion
-- SELECT COUNT(*) FROM material_quotes WHERE price = 999999.99;

-- 2. BACKFILL densities for volume-based quotes
-- MCT (Medium Chain Triglycerides) quotes with volume UOM but no density
UPDATE material_quotes mq
SET density = 0.93,
    density_unit = 'kg/L'
WHERE material_id IN (
  SELECT m.id FROM materials m 
  WHERE lower(m.name) LIKE '%medium chain%triglyceride%'
)
AND unit_of_measurement IN ('l', 'ml', 'gal_us', 'fl_oz')
AND density IS NULL;

-- MEA (Monoethanolamine) quotes with volume UOM but no density  
UPDATE material_quotes mq
SET density = 1.018,
    density_unit = 'kg/L'
WHERE material_id IN (
  SELECT m.id FROM materials m 
  WHERE lower(m.name) LIKE '%monoethanolamine%'
)
AND unit_of_measurement IN ('l', 'ml', 'gal_us', 'fl_oz')
AND density IS NULL;

-- 3. FLAG TOO_CHEAP quotes for operator review
-- These need manual verification; we mark them with a note
-- (Tenkara may not have a direct 'flag' field, so this is documentation)
-- Quote IDs to manually verify:
-- 5ec3d620-c441-4c4f-90a6-f0246d94f599: Ji'an Zhongxiang $3/26kg MCT
-- e7f74256-92ed-4488-96bc-2d51c45a2b57: Ji'an Zhongxiang $6/30kg MCT  
-- a55bcdb2-fd35-4a4a-9df2-25675a315e3e: Hangzhou Ontology $5.65/190kg MCT
-- 671cdef6-ecc7-4fc1-8f8f-14ec664f33e1: Shandong Baovi $0.4/1kg MEA
-- 6b5ad3dd-341a-49b3-873a-deedbc1e432f: R K Trading $0.52/1kg MEA
-- b6708f43-4ad9-4d1e-b72f-0cb057b9d02d: Mehta Chemicals $1.51/200kg MEA

-- Verification query: Check updated quotes now have density
SELECT id, unit_of_measurement, density, density_unit, price, case_size
FROM material_quotes
WHERE material_id IN (
  SELECT m.id FROM materials m 
  WHERE lower(m.name) LIKE '%medium chain%triglyceride%' 
     OR lower(m.name) LIKE '%monoethanolamine%'
)
AND unit_of_measurement IN ('l', 'ml', 'gal_us', 'fl_oz')
ORDER BY material_id, unit_of_measurement;
