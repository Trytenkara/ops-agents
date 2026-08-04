-- Migration 0073 - Allow 'aggregator' as a supplier_type.
--
-- Aggregators (Alibaba, IndiaMART, Made-in-China, ...) are multi-seller platforms
-- that print prices but relay every order through a "Send Inquiry" form, so they
-- are neither a marketplace you can check out on nor a direct supplier. They now
-- have their own market kind (lead site_type 'A'), and supplier profiles seeded
-- off those leads need to be able to say so.
--
-- Additive: widens the CHECK to a superset, so existing rows stay valid.

alter table public.supplier_profiles
  drop constraint if exists supplier_profiles_supplier_type_check;

alter table public.supplier_profiles
  add constraint supplier_profiles_supplier_type_check
  check (supplier_type in ('marketplace', 'aggregator', 'direct'));
