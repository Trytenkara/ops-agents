-- Soft-hide individual orgs from all user-facing UI lists without deleting them.
-- hidden=true orgs are excluded from the sidebar, clients grid, home board, etc.
-- Admin-only pages (settings, operators) still show all orgs.
alter table orgs
  add column if not exists hidden boolean not null default false;

-- Aurora (Testing Org) is a ghost/test org that should not appear in the UI.
update orgs set hidden = true where slug = 'aurora';
