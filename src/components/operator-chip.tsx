import { cn } from "@/lib/utils";
import { ROLE_CHIP, roleLabel } from "@/lib/roles";
import type { AppRole } from "@/lib/auth";

interface OperatorChipProps {
  name: string | null | undefined;
  email?: string | null;
  role?: AppRole | string | null;
  size?: "sm" | "md";
}

// Standard "<First Last> · <Role>" display used wherever an operator is referenced.
// Falls back to email if no display name; renders "—" if neither provided.
export function OperatorChip({ name, email, role, size = "sm" }: OperatorChipProps) {
  const display = name?.trim() || email || "—";
  if (display === "—") return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("font-medium", size === "sm" ? "text-sm" : "text-base")}>{display}</span>
      {role && (
        <span
          className={cn(
            "inline-flex items-center justify-center text-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide leading-tight",
            ROLE_CHIP[(role as AppRole)] ?? "bg-secondary text-secondary-foreground"
          )}
        >
          {roleLabel(role)}
        </span>
      )}
    </span>
  );
}
