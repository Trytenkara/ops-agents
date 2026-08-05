-- Un-park every marketplace price pull that was given up on.
--
-- `needs_manual_pull` was written as a status, and no cohort in
-- lead-price-pull.ts ever selects it: cohort A takes `null`/`pending`, cohort B
-- takes `pulled`. So the moment a lead exhausted its 3 attempts it left the
-- fleet permanently, with no path back. 888 leads had accumulated there, and
-- only ~73 of them were genuinely unpullable:
--
--   289  the stored URL was never a product page (a /contact page, a bare
--        homepage, an Alibaba storefront). The reader had already found the real
--        listing and said so in its notes, but the correction was discarded.
--    89  our own failure: an API 5xx, or a read that returned no JSON / ran out
--        of tokens. The page was never actually assessed.
--    ~73  a real product page that genuinely publishes no price.
--
-- The agent no longer has a terminal give-up state (see FLAG_AFTER_ATTEMPTS /
-- RETRY_BACKOFF_DAYS): a failure keeps the lead `pending` and sets `retry_after`,
-- and `flagged` carries the "an operator should look" signal instead. This
-- migration moves the existing rows onto that shape.
--
-- Attempts are preserved, so a lead that already failed many times resumes deep
-- in the backoff (monthly) rather than restarting nightly. The two causes that
-- were never the page's fault are the exception: their attempt count is reset
-- and they are made due immediately, because nothing was ever learned from them.
update leads_in_flight
   set payload = jsonb_set(
         payload,
         '{marketplace_pull}',
         (payload->'marketplace_pull')
           - 'attempts'
           || jsonb_build_object(
                'status', 'pending',
                'flagged', true,
                'unparked_at', now(),
                'attempts', case when never_assessed then 0 else attempts end,
                'retry_after', case when never_assessed then now() else retry_at end
              )
       )
  from (
    select l.id,
           coalesce((l.payload->'marketplace_pull'->>'attempts')::int, 3) as attempts,
           -- The read never happened, so the attempt should never have counted.
           (l.payload->'marketplace_pull'->>'last_notes') ~*
             '(pull failed: 5[0-9][0-9]|overloaded|Model returned no JSON|unparseable JSON|ran out of tokens|rate.?limit)'
             as never_assessed,
           -- Resume on the same curve the agent uses: [1,1,3,7,14,30] days.
           now() + (case coalesce((l.payload->'marketplace_pull'->>'attempts')::int, 3)
                      when 0 then 1 when 1 then 1 when 2 then 3
                      when 3 then 7 when 4 then 14 else 30 end || ' days')::interval
             as retry_at
      from leads_in_flight l
     where l.status = 'active'
       and l.payload->'marketplace_pull'->>'status' = 'needs_manual_pull'
  ) src
 where leads_in_flight.id = src.id;
