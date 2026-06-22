// Plain constants (NOT a "use server" module) so client components can import
// DROP_REASONS — a "use server" file may only export async functions, and a
// const exported from one is undefined on the client (crashed the drop form).

export const DROP_REASONS = [
  { value: "duplicate", label: "Duplicate of an existing lead" },
  { value: "wrong_material", label: "Wrong material" },
  { value: "not_a_supplier", label: "Not actually a supplier" },
  { value: "already_relationship", label: "Already an active relationship" },
  { value: "low_quality_signal", label: "Low quality signal" },
  { value: "out_of_scope_geo", label: "Out of geographic scope" },
  { value: "other", label: "Other" },
] as const;

export type DropReason = (typeof DROP_REASONS)[number]["value"];
