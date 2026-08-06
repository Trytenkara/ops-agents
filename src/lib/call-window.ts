// When can an operator actually reach this supplier by phone.
//
// Nothing on a supplier stores a timezone, so the window is derived from the
// country we captured at discovery (payload.supplier_country, or Tenkara's
// suppliers.country) and, for the US, the state when the enrichment blob carries
// one. Countries that straddle several zones resolve to their commercial centre
// (China to Shanghai, India to Kolkata) which is where sourcing contacts sit;
// the note explains the assumption so an operator can second-guess it.
//
// Offsets come from Intl, not a hand-kept table, so DST is handled by the
// runtime rather than by us.

// Supplier business hours, local. Deliberately narrow: a first cold call lands
// better mid-morning to mid-afternoon than at 09:00 or five minutes before close.
export const CALL_HOUR_START = 9;
export const CALL_HOUR_END = 17;

export interface CallWindow {
  timezone: string | null;
  countryLabel: string | null;
  startHour: number;
  endHour: number;
  // Rendered for surfaces with no browser to convert in (Slack, CSV).
  localLabel: string;
  etLabel: string | null;
  note: string | null;
}

const COUNTRY_ZONES: Record<string, string> = {
  // North America
  us: "America/New_York",
  usa: "America/New_York",
  "united states": "America/New_York",
  "united states of america": "America/New_York",
  ca: "America/Toronto",
  canada: "America/Toronto",
  mx: "America/Mexico_City",
  mexico: "America/Mexico_City",
  // Asia
  cn: "Asia/Shanghai",
  china: "Asia/Shanghai",
  hk: "Asia/Hong_Kong",
  "hong kong": "Asia/Hong_Kong",
  tw: "Asia/Taipei",
  taiwan: "Asia/Taipei",
  in: "Asia/Kolkata",
  india: "Asia/Kolkata",
  jp: "Asia/Tokyo",
  japan: "Asia/Tokyo",
  kr: "Asia/Seoul",
  "south korea": "Asia/Seoul",
  "korea, republic of": "Asia/Seoul",
  vn: "Asia/Ho_Chi_Minh",
  vietnam: "Asia/Ho_Chi_Minh",
  th: "Asia/Bangkok",
  thailand: "Asia/Bangkok",
  id: "Asia/Jakarta",
  indonesia: "Asia/Jakarta",
  my: "Asia/Kuala_Lumpur",
  malaysia: "Asia/Kuala_Lumpur",
  sg: "Asia/Singapore",
  singapore: "Asia/Singapore",
  ph: "Asia/Manila",
  philippines: "Asia/Manila",
  pk: "Asia/Karachi",
  pakistan: "Asia/Karachi",
  bd: "Asia/Dhaka",
  bangladesh: "Asia/Dhaka",
  lk: "Asia/Colombo",
  "sri lanka": "Asia/Colombo",
  np: "Asia/Kathmandu",
  nepal: "Asia/Kathmandu",
  il: "Asia/Jerusalem",
  israel: "Asia/Jerusalem",
  tr: "Europe/Istanbul",
  turkey: "Europe/Istanbul",
  "türkiye": "Europe/Istanbul",
  ae: "Asia/Dubai",
  "united arab emirates": "Asia/Dubai",
  uae: "Asia/Dubai",
  sa: "Asia/Riyadh",
  "saudi arabia": "Asia/Riyadh",
  // Europe
  gb: "Europe/London",
  uk: "Europe/London",
  "united kingdom": "Europe/London",
  ie: "Europe/Dublin",
  ireland: "Europe/Dublin",
  de: "Europe/Berlin",
  germany: "Europe/Berlin",
  fr: "Europe/Paris",
  france: "Europe/Paris",
  es: "Europe/Madrid",
  spain: "Europe/Madrid",
  it: "Europe/Rome",
  italy: "Europe/Rome",
  nl: "Europe/Amsterdam",
  netherlands: "Europe/Amsterdam",
  be: "Europe/Brussels",
  belgium: "Europe/Brussels",
  ch: "Europe/Zurich",
  switzerland: "Europe/Zurich",
  at: "Europe/Vienna",
  austria: "Europe/Vienna",
  pl: "Europe/Warsaw",
  poland: "Europe/Warsaw",
  cz: "Europe/Prague",
  "czech republic": "Europe/Prague",
  czechia: "Europe/Prague",
  pt: "Europe/Lisbon",
  portugal: "Europe/Lisbon",
  se: "Europe/Stockholm",
  sweden: "Europe/Stockholm",
  no: "Europe/Oslo",
  norway: "Europe/Oslo",
  dk: "Europe/Copenhagen",
  denmark: "Europe/Copenhagen",
  fi: "Europe/Helsinki",
  finland: "Europe/Helsinki",
  gr: "Europe/Athens",
  greece: "Europe/Athens",
  ua: "Europe/Kyiv",
  ukraine: "Europe/Kyiv",
  ru: "Europe/Moscow",
  russia: "Europe/Moscow",
  // Latin America
  br: "America/Sao_Paulo",
  brazil: "America/Sao_Paulo",
  ar: "America/Argentina/Buenos_Aires",
  argentina: "America/Argentina/Buenos_Aires",
  cl: "America/Santiago",
  chile: "America/Santiago",
  co: "America/Bogota",
  colombia: "America/Bogota",
  pe: "America/Lima",
  peru: "America/Lima",
  // Africa + Oceania
  za: "Africa/Johannesburg",
  "south africa": "Africa/Johannesburg",
  eg: "Africa/Cairo",
  egypt: "Africa/Cairo",
  ma: "Africa/Casablanca",
  morocco: "Africa/Casablanca",
  ng: "Africa/Lagos",
  nigeria: "Africa/Lagos",
  ke: "Africa/Nairobi",
  kenya: "Africa/Nairobi",
  au: "Australia/Sydney",
  australia: "Australia/Sydney",
  nz: "Pacific/Auckland",
  "new zealand": "Pacific/Auckland",
};

const US_STATE_ZONES: Record<string, string> = {
  ct: "America/New_York", de: "America/New_York", dc: "America/New_York", fl: "America/New_York",
  ga: "America/New_York", in: "America/New_York", ky: "America/New_York", me: "America/New_York",
  md: "America/New_York", ma: "America/New_York", mi: "America/New_York", nh: "America/New_York",
  nj: "America/New_York", ny: "America/New_York", nc: "America/New_York", oh: "America/New_York",
  pa: "America/New_York", ri: "America/New_York", sc: "America/New_York", vt: "America/New_York",
  va: "America/New_York", wv: "America/New_York",
  al: "America/Chicago", ar: "America/Chicago", il: "America/Chicago", ia: "America/Chicago",
  ks: "America/Chicago", la: "America/Chicago", mn: "America/Chicago", ms: "America/Chicago",
  mo: "America/Chicago", ne: "America/Chicago", nd: "America/Chicago", ok: "America/Chicago",
  sd: "America/Chicago", tn: "America/Chicago", tx: "America/Chicago", wi: "America/Chicago",
  az: "America/Phoenix", co: "America/Denver", id: "America/Denver", mt: "America/Denver",
  nm: "America/Denver", ut: "America/Denver", wy: "America/Denver",
  ca: "America/Los_Angeles", nv: "America/Los_Angeles", or: "America/Los_Angeles", wa: "America/Los_Angeles",
  ak: "America/Anchorage", hi: "Pacific/Honolulu",
};

const US_STATE_NAMES: Record<string, string> = {
  california: "ca", texas: "tx", "new york": "ny", florida: "fl", illinois: "il", "new jersey": "nj",
  pennsylvania: "pa", ohio: "oh", georgia: "ga", "north carolina": "nc", michigan: "mi",
  washington: "wa", oregon: "or", arizona: "az", colorado: "co", massachusetts: "ma",
  tennessee: "tn", indiana: "in", missouri: "mo", wisconsin: "wi", minnesota: "mn",
  maryland: "md", virginia: "va", "south carolina": "sc", alabama: "al", louisiana: "la",
  kentucky: "ky", oklahoma: "ok", utah: "ut", nevada: "nv", connecticut: "ct", iowa: "ia",
  kansas: "ks", arkansas: "ar", mississippi: "ms", nebraska: "ne", "new mexico": "nm",
  idaho: "id", "west virginia": "wv", hawaii: "hi", "new hampshire": "nh", maine: "me",
  montana: "mt", "rhode island": "ri", delaware: "de", "south dakota": "sd", "north dakota": "nd",
  alaska: "ak", vermont: "vt", wyoming: "wy",
};

function norm(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\./g, "");
}

function isUnitedStates(country: string): boolean {
  return country === "us" || country === "usa" || country.startsWith("united states");
}

// IANA zone for a supplier, or null when we hold no country at all.
export function resolveTimezone(country: string | null | undefined, region?: string | null): string | null {
  const c = norm(country);
  if (!c) return null;
  if (isUnitedStates(c)) {
    const r = norm(region);
    const code = r.length === 2 ? r : US_STATE_NAMES[r] ?? "";
    return US_STATE_ZONES[code] ?? "America/New_York";
  }
  return COUNTRY_ZONES[c] ?? null;
}

// Minutes a zone is ahead of UTC at a given instant. Formats the instant in the
// zone, reads that wall clock back as if it were UTC, and diffs: the standard
// Intl-only way to get an offset without shipping a tz database.
export function zoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Hour 24 is how en-US hour12:false renders midnight; Date.UTC rolls it over.
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

// Half-hour and 45-minute zones exist (India +5:30, Nepal +5:45), so the minutes
// are computed, not assumed to be :00 or :30.
function fmtHour(h: number): string {
  const totalMinutes = Math.round((((h % 24) + 24) % 24) * 60);
  const hh = Math.floor(totalMinutes / 60) % 24;
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// Which calendar day an endpoint lands on relative to the supplier's own
// business day. Tagged per endpoint, not per range: an Asian supplier's 09:00 to
// 17:00 is 21:00 the evening BEFORE through 05:00 the same morning in ET, and
// labelling the whole span "previous day" misreads the end of it.
function dayTag(h: number): string {
  if (h < 0) return " (prev day)";
  if (h >= 24) return " (next day)";
  return "";
}

// Render a supplier-local hour range as it falls on another zone's clock.
export function shiftRangeLabel(startHour: number, endHour: number, deltaHours: number): string {
  const s = startHour + deltaHours;
  const e = endHour + deltaHours;
  return `${fmtHour(s)}${dayTag(s)} to ${fmtHour(e)}${dayTag(e)}`;
}

function shiftRange(startHour: number, endHour: number, fromTz: string, toTz: string, at: Date): string {
  return shiftRangeLabel(startHour, endHour, (zoneOffsetMinutes(toTz, at) - zoneOffsetMinutes(fromTz, at)) / 60);
}

// Is the supplier inside its own business hours right now, ignoring weekends?
// Weekends are left to the operator: a Saturday is obvious on the clock we show,
// and some of these suppliers do answer on one.
export function isWithinWindow(timeZone: string, at: Date = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit" }).format(at)
  ) % 24;
  return hour >= CALL_HOUR_START && hour < CALL_HOUR_END;
}

export function buildCallWindow(
  country: string | null | undefined,
  region?: string | null,
  at: Date = new Date()
): CallWindow {
  const timezone = resolveTimezone(country, region);
  const countryLabel = String(country ?? "").trim() || null;
  const localLabel = `${fmtHour(CALL_HOUR_START)} to ${fmtHour(CALL_HOUR_END)} local`;

  if (!timezone) {
    return {
      timezone: null,
      countryLabel,
      startHour: CALL_HOUR_START,
      endHour: CALL_HOUR_END,
      localLabel,
      etLabel: null,
      note: countryLabel
        ? `No timezone mapped for "${countryLabel}". Check the supplier's own site before dialing.`
        : "No country on file, so the local calling window is unknown. Check the supplier's own site before dialing.",
    };
  }

  const multiZone = isUnitedStates(norm(country)) && !region;
  return {
    timezone,
    countryLabel,
    startHour: CALL_HOUR_START,
    endHour: CALL_HOUR_END,
    localLabel,
    etLabel: shiftRange(CALL_HOUR_START, CALL_HOUR_END, timezone, "America/New_York", at),
    note: multiZone
      ? "No state on file, so this assumes Eastern. Confirm against the supplier's address."
      : null,
  };
}
