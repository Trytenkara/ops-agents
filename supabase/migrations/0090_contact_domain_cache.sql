-- Per-domain contact memo.
--
-- Contact resolution is keyed on a supplier's domain, but the fleet runs it once
-- per LEAD. Measured over 7 days: 7,801 enrichment attempts touched only 4,893
-- distinct domains, so ~37% of the work (and of the paid-provider billing) was a
-- repeat of a domain already resolved. apexherbex.trustpass.alibaba.com alone was
-- billed 29 times in a week.
--
-- A domain resolves to the same contact regardless of which org's lead asked, and
-- regardless of the material, so the answer is cached here and reused.
--
-- A miss is never terminal (see feedback: never give up on a retryable failure).
-- miss_count drives an exponential retry_after; once it elapses the domain is
-- re-attempted from scratch, forever. retry_after only ever suppresses the PAID
-- providers, never the free crawl.
create table if not exists contact_domain_cache (
  domain          text primary key,
  email           text,
  phone           text,
  contact_url     text,
  poc_name        text,
  poc_title       text,
  source          text,          -- ContactDiscovery["source"] that produced the hit
  confidence      text,          -- 'verified' | 'guessed'
  hit_count       int  not null default 0,   -- times this cache row served a lead
  miss_count      int  not null default 0,   -- consecutive resolutions that found nothing
  resolved_at     timestamptz,
  last_attempt_at timestamptz,
  retry_after     timestamptz,   -- paid providers stay off until this passes
  updated_at      timestamptz not null default now()
);

create index if not exists contact_domain_cache_retry_idx
  on contact_domain_cache (retry_after)
  where email is null;

-- Reuse counter, so the saving this table produces is measurable rather than
-- assumed. Separate from the upsert because the hit path writes nothing else.
create or replace function increment_contact_cache_hit(p_domain text)
returns void
language sql
as $$
  update contact_domain_cache
     set hit_count = hit_count + 1, updated_at = now()
   where domain = p_domain;
$$;
