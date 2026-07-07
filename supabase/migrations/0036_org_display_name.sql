-- Dashboard-only display name override for an org. The canonical `name` must
-- stay in sync with the Tenkara `organizations.name` (agents match on it and the
-- org sync upserts it), so ghost/internal orgs that should appear under a
-- different brand in the dashboard use `display_name`. NULL = show `name`.
alter table public.orgs add column if not exists display_name text;

-- orgs already has a BEFORE UPDATE trigger (trg_touch_orgs → touch_updated_at)
-- that sets new.updated_at, but the column was never added — so every UPDATE to
-- orgs errored ("record new has no field updated_at"), including the org sync's
-- conflict-update path. Add the column the trigger expects (matches every other
-- touch_updated_at table).
alter table public.orgs add column if not exists updated_at timestamptz not null default now();
