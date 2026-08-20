/**
 * DATA-07 enforcement: Volume-based quotes require density for conversion to $/lb
 *
 * A quote priced in litres, millilitres, gallons or fluid ounces cannot be
 * converted to $/kg or $/lb without knowing the density. Rejecting these quotes
 * at capture prevents them from silently entering the system as unconvertible.
 *
 * This is the shared guard. Callers:
 * - insertStagedQuotes (price capture path)
 * - quote form validation (Tenkara)
 * - Agent 05 pre-storage check (marketplace price pull)
 */

export interface QuoteValidationResult {
  valid: boolean;
  reason?: string;
}

const VOLUME_UNITS = new Set(['l', 'ml', 'gal_us', 'gal', 'fl_oz', 'cc', 'cm3']);

/**
 * Validate that volume-based quotes have a density value.
 * If the quote is priced in volume units, density MUST be present.
 *
 * @param unitOfMeasurement The UOM from the quote (normalized to lowercase)
 * @param density The density value (null, 0, or a positive number)
 * @returns {valid: true} if OK, {valid: false, reason: "..."} if rejected
 */
export function validateQuoteDensity(
  unitOfMeasurement: string | null | undefined,
  density: number | null | undefined
): QuoteValidationResult {
  if (!unitOfMeasurement) {
    return { valid: true }; // Can't validate without UOM
  }

  const uom = String(unitOfMeasurement).toLowerCase().trim();

  // Not a volume unit — no density required
  if (!VOLUME_UNITS.has(uom)) {
    return { valid: true };
  }

  // Volume unit BUT density is missing
  if (density === null || density === undefined || density <= 0) {
    return {
      valid: false,
      reason: `Quote priced in ${uom} (volume) requires density (kg/L or g/ml) to convert to $/lb. Store density or correct the unit of measurement.`,
    };
  }

  return { valid: true };
}

/**
 * Enforce at insertion time. Called before storing a quote.
 * Throws if validation fails, preventing bad quotes from entering.
 */
export function assertQuoteDensity(
  unitOfMeasurement: string | null | undefined,
  density: number | null | undefined,
  quoteId?: string
): void {
  const result = validateQuoteDensity(unitOfMeasurement, density);
  if (!result.valid) {
    throw new Error(
      `DATA-07 violation: ${result.reason}${quoteId ? ` (quote ${quoteId})` : ""}`
    );
  }
}
