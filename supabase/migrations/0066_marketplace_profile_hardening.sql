create unique index if not exists quote_profiles_org_supplier_material_ids_idx
  on public.quote_profiles (org_id, supplier_id, material_id)
  where supplier_id is not null and material_id is not null;

create unique index if not exists quote_profiles_org_supplier_material_names_idx
  on public.quote_profiles (org_id, lower(trim(supplier_name)), lower(trim(material_name)))
  where supplier_id is null or material_id is null;
