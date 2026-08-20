-- A quote row now says which relationship it came from.
--
-- When a marketplace starts dealing by email we deliberately stand up a second,
-- direct supplier with the SAME company name (splitDirectLeadFromMarketplace).
-- quote_profiles keyed only on supplier + material, so the two relationships
-- shared one bucket and either writer could adopt the other's row: a scraped
-- listing price could land on a negotiated quote, or the reverse. The email
-- seeder was fenced off by a text prefix in purchasing_notes; the marketplace
-- filler had no fence at all.
--
-- lane is that fence, recorded at write time instead of guessed afterwards.
--   marketplace = read off a public product page by the price pull
--   direct      = quoted to us, by email or by an operator
alter table public.quote_profiles
  add column if not exists lane text
    check (lane in ('marketplace', 'direct'));

-- Backfill, in the order the evidence is strongest.
-- 1. The marketplace filler labels every row it inserts.
update public.quote_profiles
   set lane = 'marketplace'
 where lane is null
   and purchasing_notes like 'Auto-filled from marketplace listing%';

-- 2. Rows predating that label. An absolute http(s) source_url is a product
--    page: only the listing path ever writes one. Email-seeded rows carry a
--    relative /api/external/attachments/... path instead, which is the reply's
--    attachment, so those are excluded here and fall through to direct.
update public.quote_profiles
   set lane = 'marketplace'
 where lane is null
   and source_url ~* '^https?://';

-- 3. Everything left came from a reply or an operator.
update public.quote_profiles
   set lane = 'direct'
 where lane is null;

alter table public.quote_profiles
  alter column lane set not null,
  alter column lane set default 'direct';

create index if not exists quote_profiles_org_lane_idx
  on public.quote_profiles (org_id, lane);
