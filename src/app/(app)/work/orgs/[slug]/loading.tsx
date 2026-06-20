// Shown while a client tab's server data (incl. slow Tenkara calls) loads, so
// the operator sees a skeleton instead of a blank screen. The layout (header,
// stepper, subnav) stays put; only the tab body is replaced.
export default function Loading() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="h-5 w-48 rounded bg-muted" />
      <div className="h-3 w-2/3 rounded bg-muted/70" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 w-full rounded bg-muted/50" />
        ))}
      </div>
    </div>
  );
}
