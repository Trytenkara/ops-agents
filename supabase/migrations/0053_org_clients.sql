-- org_clients: managed list of potential client names per org.
-- Operators create these once; material_client_tags references them by FK
-- so spellings are canonical across all tagged materials and pages.
CREATE TABLE public.org_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE INDEX org_clients_org_idx ON public.org_clients(org_id);

-- Replace free-text client_name on material_client_tags with a FK reference.
-- material_name is stored denormalized so price-index and savings pages can
-- filter by material name without an extra join.
ALTER TABLE public.material_client_tags
  DROP COLUMN client_name,
  ADD COLUMN org_client_id uuid REFERENCES public.org_clients(id) ON DELETE SET NULL,
  ADD COLUMN material_name text;
