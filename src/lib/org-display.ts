// Dashboard display name for an org. Prefers the dashboard-only `display_name`
// override, falling back to the canonical `name` (which stays in sync with
// Tenkara for agent matching). Use everywhere an org name is shown to the user.
export function orgDisplayName(org: { display_name?: string | null; name: string }): string {
  return org.display_name?.trim() || org.name;
}
