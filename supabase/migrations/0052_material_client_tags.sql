-- Per-org metadata for materials: client name tag (manual, for orgs like Sierra
-- that source for multiple potential clients) and a priority flag that moves the
-- material to the front of Agent 03's discovery queue for that org's next run.
CREATE TABLE public.material_client_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  tenkara_material_id text NOT NULL,
  client_name text NOT NULL DEFAULT '',
  is_priority boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, tenkara_material_id)
);

CREATE INDEX material_client_tags_org_idx ON public.material_client_tags(org_id);
