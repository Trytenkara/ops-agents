-- Dashboard-only display name override for an org. The canonical `name` must
-- stay in sync with the Tenkara `organizations.name` (agents match on it and the
-- org sync upserts it), so ghost/internal orgs that should appear under a
-- different brand in the dashboard use `display_name`. NULL = show `name`.
alter table public.orgs add column if not exists display_name text;
