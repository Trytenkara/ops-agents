-- Primary/Backup is gone, so the table is dropped rather than left behind where a
-- read path could quietly keep resolving through it.
--
-- Separate from 0106 on purpose. 0106 only adds columns, which the running build
-- ignores, so it can go in before the deploy. This one has to wait until the new
-- build is live, because the old one still reads this table as its fallback and
-- would start handing back unowned work the moment it disappears.
drop table if exists public.org_default_operators;
