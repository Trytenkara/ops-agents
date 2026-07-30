// Advisory quality flags for a lead. These NEVER filter a lead out of the
// pipeline — they are surfaced as badges so an operator sees a caveat while the
// lead stays actionable. Computed as a pure function of the stored payload (plus
// the client's dealbreaker certs, passed in), so they work retroactively on
// every existing lead with no re-run and no DB write.

export interface LeadFlag {
  code: "inactive_site" | "missing_cert" | "sample_only" | "below_onboarded_bar";
  label: string;
}

export interface LeadFlagContext {
  // Names of certifications the client marked as dealbreakers for this material's
  // org (from getClientRequirements). Empty when the client configured none.
  dealbreakerCerts?: string[];
}

// The listing enrichment probed is gone (404/410). Deliberately NOT any error:
// 403/401/429/5xx mean the site blocked our crawler or hiccuped, not that the
// business is dead (real firms like Lonza and Nordic Naturals return 403 to
// bots). Only a definitive not-found/gone is a reliable "dead listing" signal.
function inactiveSite(payload: any): LeadFlag | null {
  const wp = payload?.enrichment?.website_probe;
  if (!wp || typeof wp !== "object") return null;
  const status = typeof wp.status_code === "number" ? wp.status_code : null;
  if (status === 404 || status === 410) {
    return { code: "inactive_site", label: `Listing not found (${status})` };
  }
  return null;
}

// The client requires a dealbreaker certification the supplier's listed certs
// don't mention. Substring match (case-insensitive) against the free-text certs.
function missingCert(payload: any, dealbreakerCerts: string[]): LeadFlag | null {
  if (!dealbreakerCerts.length) return null;
  const have = String(payload?.certifications ?? "").toLowerCase();
  const missing = dealbreakerCerts.filter((c) => c.trim() && !have.includes(c.trim().toLowerCase()));
  if (missing.length === 0) return null;
  return { code: "missing_cert", label: `Missing required cert: ${missing.join(", ")}` };
}

// Supplier appears to sell sample / trial sizes only, not commercial volume.
// Deliberately conservative — an explicit phrase, never an inference from a size
// number — so it doesn't misfire on suppliers that merely offer a sample too.
function sampleOnly(payload: any): LeadFlag | null {
  const text = [payload?.scout_notes, payload?.grades_offered, payload?.pack_sizes_pricing, payload?.moq]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/\bsample[- ]?only\b|sample sizes? only|trial sizes? only|not for (re)?sale/.test(text)) {
    return { code: "sample_only", label: "Sample-only supplier" };
  }
  return null;
}

// The client has been marked "onboarded" and this lead was re-filtered below the
// onboarded bar (see lib/onboarded-bar.ts). Read straight from the advisory the
// re-filter wrote (payload.below_onboarded_bar) so it renders retroactively with
// no recompute; clearing that advisory (moving back to motherlode) drops the flag.
function belowOnboardedBar(payload: any): LeadFlag | null {
  const b = payload?.below_onboarded_bar;
  if (!b || typeof b !== "object") return null;
  const reason = typeof b.reason === "string" && b.reason.trim() ? `: ${b.reason.trim()}` : "";
  return { code: "below_onboarded_bar", label: `Below onboarded bar${reason}` };
}

export function computeLeadFlags(payload: any, ctx: LeadFlagContext = {}): LeadFlag[] {
  const flags: LeadFlag[] = [];
  const site = inactiveSite(payload);
  if (site) flags.push(site);
  const cert = missingCert(payload, ctx.dealbreakerCerts ?? []);
  if (cert) flags.push(cert);
  const sample = sampleOnly(payload);
  if (sample) flags.push(sample);
  const onboarded = belowOnboardedBar(payload);
  if (onboarded) flags.push(onboarded);
  return flags;
}
