// Advisory quality flags for a lead. These NEVER filter a lead out of the
// pipeline — they are surfaced as badges so an operator sees a caveat while the
// lead stays actionable. Computed as a pure function of the stored payload (plus
// the client's dealbreaker certs, passed in), so they work retroactively on
// every existing lead with no re-run and no DB write.

export interface LeadFlag {
  code: "inactive_site" | "missing_cert" | "sample_only" | "dealbreaker_met" | "direct_contact";
  label: string;
  // Most flags are caveats. A few are positive signals and must not be rendered
  // in warning colours; the renderer keys the badge variant off this.
  tone?: "warn" | "good";
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

// Enrichment checked the client's dealbreaker grades/certs against the evidence
// held for this supplier and found support for ALL of them. See lib/dealbreaker-fit.ts.
//
// Deliberately the POSITIVE side of the verdict. Badging the negative was tried
// and measured against live data first: it fires on 41% of a real client's leads
// even when restricted to partial matches, because most raw listings name the
// material and never name its grade, so "not evidenced" is the default state and
// says nothing about the supplier. "Meets" is the scarce, actionable signal (6-14%
// per org) and it points an operator at the leads worth working first. The full
// tri-state verdict is still recorded on the payload for sorting.
function dealbreakerMet(payload: any): LeadFlag | null {
  const fit = payload?.enrichment?.dealbreaker_fit;
  if (!fit || fit.verdict !== "meets") return null;
  const satisfied = Array.isArray(fit.satisfied) ? fit.satisfied.filter(Boolean) : [];
  if (!satisfied.length) return null;
  return { code: "dealbreaker_met", label: `Meets dealbreakers: ${satisfied.join(", ")}`, tone: "good" };
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

// The seller replied from its own domain, so the lead left the marketplace track
// and is now worked as a direct supplier. Positive signal, and the only place the
// marketplace origin stays visible afterwards: site_type is now "N", so the
// "via <platform>" sub-label on the row stops rendering.
function directContact(payload: any): LeadFlag | null {
  if (payload?.aggregator_direct_contact !== true) return null;
  const platform = typeof payload?.aggregator === "string" ? payload.aggregator.trim() : "";
  return {
    code: "direct_contact",
    label: platform ? `Direct contact, via ${platform}` : "Direct contact captured",
    tone: "good",
  };
}

export function computeLeadFlags(payload: any, ctx: LeadFlagContext = {}): LeadFlag[] {
  const flags: LeadFlag[] = [];
  const site = inactiveSite(payload);
  if (site) flags.push(site);
  // A "meets" verdict already checked the dealbreaker certs against site-parsed
  // certs, which missingCert cannot see, so it supersedes rather than contradicts.
  const db = dealbreakerMet(payload);
  if (db) flags.push(db);
  else {
    const cert = missingCert(payload, ctx.dealbreakerCerts ?? []);
    if (cert) flags.push(cert);
  }
  const sample = sampleOnly(payload);
  if (sample) flags.push(sample);
  const direct = directContact(payload);
  if (direct) flags.push(direct);
  return flags;
}
