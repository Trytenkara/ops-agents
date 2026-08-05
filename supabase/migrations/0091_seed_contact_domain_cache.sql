-- Seed the per-domain contact memo from contacts the fleet already resolved.
--
-- Without this the cache starts empty and only pays off for domains seen again
-- AFTER deploy, while the ~3,700 contacts already sitting in leads_in_flight
-- would be re-resolved (and, on the paid path, re-billed) the next time the same
-- supplier arrives on a different material or org.
--
-- Only real, own-domain addresses are seeded: the email's domain has to match the
-- supplier website it was found on. A guessed-pattern address is skipped, because
-- caching a guess as a resolution would stop the domain ever being read for its
-- real inbox.
insert into contact_domain_cache (domain, email, phone, contact_url, poc_name, poc_title, source, confidence, resolved_at, last_attempt_at, updated_at)
select distinct on (d.domain)
       d.domain, d.email, d.phone, d.contact_url, d.poc_name, d.poc_title,
       d.source, 'verified', d.seen_at, d.seen_at, now()
  from (
    select lower(regexp_replace(coalesce(l.payload->>'supplier_website',''), '^https?://(www\.)?([^/]+).*$', '\2')) as domain,
           lower(coalesce(l.payload->>'supplier_contact_email', l.payload->'enrichment'->'contact'->>'email'))     as email,
           nullif(coalesce(l.payload->>'supplier_phone', l.payload->'enrichment'->'contact'->>'phone'), '')        as phone,
           nullif(l.payload->'enrichment'->'contact'->>'contact_url', '')                                          as contact_url,
           nullif(l.payload->'enrichment'->'contact'->>'poc_name', '')                                             as poc_name,
           nullif(l.payload->'enrichment'->'contact'->>'poc_title', '')                                            as poc_title,
           coalesce(l.payload->'enrichment'->'contact'->>'source', 'discovered')                                   as source,
           coalesce(l.last_enrichment_attempt_at, l.created_at)                                                    as seen_at
      from leads_in_flight l
     where coalesce(l.payload->>'supplier_website','') <> ''
       and coalesce(l.payload->>'supplier_contact_email', l.payload->'enrichment'->'contact'->>'email','') <> ''
       and coalesce(l.payload->'enrichment'->>'contact_confidence','') is distinct from 'guessed'
       and coalesce(l.payload->'enrichment'->'contact'->>'source','') is distinct from 'pattern_guess'
  ) d
 where d.domain <> ''
   and d.domain like '%.%'
   -- Own-domain only: an address on a different domain than the site it was
   -- found on is a third-party service or an aggregator relay, not this
   -- supplier's inbox, and must never be keyed to this domain.
   and split_part(d.email, '@', 2) = d.domain
 order by d.domain, d.seen_at desc nulls last
on conflict (domain) do nothing;
