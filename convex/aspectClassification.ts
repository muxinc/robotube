/**
 * Aspect-ratio eligibility contract for the vertical (Shorts) feed.
 *
 * This module is free of Convex imports so parsing, normalization, and
 * placement rules can be unit tested directly:
 *
 *   node --experimental-strip-types --test tests/aspect-classification.test.ts
 *
 * The processed Mux display ratio is the only authoritative input. Screen size,
 * thumbnail size, player layout, and encoded rotation metadata are never
 * reinterpreted here or on the client.
 *
 * Normalization rule:
 *
 *   1. Parse both sides of a `width:height` string as exact positive integers.
 *   2. Divide both by their greatest common divisor.
 *   3. Store the reduced ratio.
 *   4. `vertical` only when the reduced ratio is exactly `9:16`.
 *   5. `standard` for every other valid reduced ratio.
 *   6. `unknown` for missing, malformed, zero, negative, non-integer, or
 *      oversized data. `unknown` is never assumed to be `9:16`.
 *
 * The grammar is exactly `<digits>:<digits>`. Whitespace anywhere in the value,
 * including around a component, is malformed rather than trimmed: the qualifying
 * ratio is exact, so the parser does not repair its input.
 */

export type FeedPlacement = "standard" | "vertical" | "unknown";

export type AspectClassification = {
  /** Normalized reduced ratio, for example `"9:16"`. Null when unknown. */
  aspectRatio: string | null;
  feedPlacement: FeedPlacement;
};

export const FEED_PLACEMENTS = ["standard", "vertical", "unknown"] as const;

/** The one ratio that qualifies for the vertical feed. No tolerance band. */
export const VERTICAL_ASPECT_RATIO = "9:16";

export const UNKNOWN_ASPECT_CLASSIFICATION: AspectClassification = {
  aspectRatio: null,
  feedPlacement: "unknown",
};

/**
 * Digits allowed per side after leading zeros are stripped. 15 digits stay
 * inside `Number.MAX_SAFE_INTEGER` (16 digits), so the GCD reduction below is
 * exact integer math. Anything larger is treated as unusable rather than
 * silently reduced with floating-point error.
 */
export const MAX_RATIO_COMPONENT_DIGITS = 15;

export const RATIO_SEPARATOR = ":";

/** Keys a Mux payload may use for the display ratio (snake_case and camelCase). */
export const MUX_ASPECT_RATIO_PAYLOAD_KEYS = ["aspect_ratio", "aspectRatio"] as const;

/** Nested raw-payload key checked when the top-level keys are absent. */
export const MUX_RAW_PAYLOAD_KEY = "raw";

export type IntegerRatio = {
  width: number;
  height: number;
};

const ASCII_DIGITS_ONLY = /^[0-9]+$/;

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isFeedPlacement(value: unknown): value is FeedPlacement {
  return (
    typeof value === "string" &&
    (FEED_PLACEMENTS as readonly string[]).includes(value)
  );
}

/**
 * Exact positive-integer parse. Rejects signs, decimal points, exponents,
 * thousands separators, non-ASCII digits, any whitespace, zero, and values too
 * large for exact integer math.
 */
function parseExactPositiveInteger(rawValue: string): number | null {
  if (rawValue.length === 0) return null;
  if (!ASCII_DIGITS_ONLY.test(rawValue)) return null;

  // `"09"` is still exactly 9; strip leading zeros before the size guard so a
  // zero-padded small number is not mistaken for an oversized one.
  const digits = rawValue.replace(/^0+/, "");
  if (digits.length === 0) return null; // "0", "000"
  if (digits.length > MAX_RATIO_COMPONENT_DIGITS) return null;

  const parsed = Number(digits);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;

  return parsed;
}

/** Parses `"width:height"` into exact positive integers, or null. */
export function parseExactIntegerRatio(value: unknown): IntegerRatio | null {
  if (typeof value !== "string") return null;

  const parts = value.split(RATIO_SEPARATOR);
  if (parts.length !== 2) return null;

  const width = parseExactPositiveInteger(parts[0] ?? "");
  const height = parseExactPositiveInteger(parts[1] ?? "");
  if (width === null || height === null) return null;

  return { width, height };
}

/** Euclidean GCD on non-negative integers. Returns 0 only for `0, 0`. */
export function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));

  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a;
}

export function reduceIntegerRatio(ratio: IntegerRatio): IntegerRatio {
  const divisor = greatestCommonDivisor(ratio.width, ratio.height);
  if (divisor <= 0) return ratio;

  return { width: ratio.width / divisor, height: ratio.height / divisor };
}

/** Reduced `"width:height"` string, or null when the input is unusable. */
export function normalizeAspectRatio(value: unknown): string | null {
  const parsed = parseExactIntegerRatio(value);
  if (!parsed) return null;

  const reduced = reduceIntegerRatio(parsed);
  return `${reduced.width}${RATIO_SEPARATOR}${reduced.height}`;
}

export function classifyAspectRatio(value: unknown): AspectClassification {
  const aspectRatio = normalizeAspectRatio(value);
  if (aspectRatio === null) return UNKNOWN_ASPECT_CLASSIFICATION;

  return {
    aspectRatio,
    feedPlacement:
      aspectRatio === VERTICAL_ASPECT_RATIO ? "vertical" : "standard",
  };
}

export type MuxAspectRatioInput = {
  /**
   * True only when the payload actually carries ratio data. A payload without
   * ratio data (for example `video.asset.created`) must not overwrite a
   * classification that a later `video.asset.ready` event already produced.
   */
  provided: boolean;
  value: unknown;
  /** Which key supplied the value, for diagnostics. */
  sourceKey: string | null;
};

const ABSENT_ASPECT_RATIO_INPUT: MuxAspectRatioInput = {
  provided: false,
  value: undefined,
  sourceKey: null,
};

function readAspectRatioKeys(
  record: Record<string, unknown>,
  keyPrefix: string,
): MuxAspectRatioInput | null {
  for (const key of MUX_ASPECT_RATIO_PAYLOAD_KEYS) {
    if (!(key in record)) continue;

    const value = record[key];
    // Present-but-empty carries no ratio data, so it is treated as absent
    // rather than as an authoritative "this asset has no ratio".
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;

    return { provided: true, value, sourceKey: `${keyPrefix}${key}` };
  }

  return null;
}

/**
 * Reads the display ratio from any Mux-shaped payload:
 *
 *   - webhook `data` and Mux SDK assets use snake_case `aspect_ratio`;
 *   - Mux component asset rows use camelCase `aspectRatio` and keep the
 *     original payload under `raw`.
 */
export function readMuxAspectRatioInput(payload: unknown): MuxAspectRatioInput {
  const record = asPlainRecord(payload);
  if (!record) return ABSENT_ASPECT_RATIO_INPUT;

  const topLevel = readAspectRatioKeys(record, "");
  if (topLevel) return topLevel;

  const raw = asPlainRecord(record[MUX_RAW_PAYLOAD_KEY]);
  if (raw) {
    const nested = readAspectRatioKeys(raw, `${MUX_RAW_PAYLOAD_KEY}.`);
    if (nested) return nested;
  }

  return ABSENT_ASPECT_RATIO_INPUT;
}

export type MuxPayloadAspectClassification = AspectClassification & {
  provided: boolean;
  sourceKey: string | null;
};

/**
 * Classifies a Mux payload. `provided: false` means the payload carried no
 * ratio data at all; `provided: true` with `feedPlacement: "unknown"` means the
 * payload carried ratio data that is not usable, which is authoritative.
 */
export function classifyMuxAssetPayloadAspect(
  payload: unknown,
): MuxPayloadAspectClassification {
  const input = readMuxAspectRatioInput(payload);
  if (!input.provided) {
    return { ...UNKNOWN_ASPECT_CLASSIFICATION, provided: false, sourceKey: null };
  }

  return {
    ...classifyAspectRatio(input.value),
    provided: true,
    sourceKey: input.sourceKey,
  };
}

/** The classification columns denormalized onto a cached asset row. */
export type AspectClassificationFields = {
  aspectRatio?: string;
  feedPlacement?: FeedPlacement;
  aspectRatioUpdatedAtMs?: number;
};

type StoredClassification = {
  aspectRatio?: string | null;
  feedPlacement?: string | null;
};

export type AspectClassificationUpsert = {
  aspectRatio: string | undefined;
  feedPlacement: FeedPlacement;
  /** True when the stored classification must be rewritten. */
  changed: boolean;
};

function asRatioString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStoredPlacement(value: unknown): FeedPlacement | undefined {
  return isFeedPlacement(value) ? value : undefined;
}

/**
 * Decides the classification an asset upsert should store.
 *
 * - Incoming ratio data wins, even when it classifies to `unknown`: Mux is
 *   authoritative and a ratio that stops parsing must not keep a stale
 *   placement.
 * - A payload without ratio data preserves the stored classification, matching
 *   the "only write what was provided" rule the read-model writers follow.
 * - A row that has never been classified resolves to an explicit `unknown` so
 *   every row is countable in the coverage audit. `unknown` rows stay off both
 *   indexed feeds and remain visible on the legacy Home path.
 */
export function resolveAspectClassificationForUpsert(args: {
  existing?: StoredClassification | null;
  incoming: StoredClassification;
}): AspectClassificationUpsert {
  const existingPlacement = asStoredPlacement(args.existing?.feedPlacement);
  const existingRatio = asRatioString(args.existing?.aspectRatio);
  const incomingPlacement = asStoredPlacement(args.incoming.feedPlacement);

  const resolved =
    incomingPlacement !== undefined
      ? {
          aspectRatio: asRatioString(args.incoming.aspectRatio),
          feedPlacement: incomingPlacement,
        }
      : {
          aspectRatio: existingRatio,
          feedPlacement: existingPlacement ?? ("unknown" as FeedPlacement),
        };

  return {
    ...resolved,
    changed:
      resolved.feedPlacement !== existingPlacement ||
      resolved.aspectRatio !== existingRatio,
  };
}

/**
 * Cross-field integrity check for a stored classification.
 *
 * `aspectRatio` and `feedPlacement` are written together from one payload, so
 * they must always agree. A row that disagrees — a stored `9:16` marked
 * `standard`, an unnormalized `1080:1920`, a ratio that no longer parses, a
 * placement with no ratio, or a ratio with no placement — is corrupt rather than
 * merely unclassified, and would be served by the wrong indexed feed. The
 * placement audit counts these and
 * `feedPlacement.backfillAspectClassification` with `force` repairs them.
 */
export function isStoredAspectClassificationConsistent(
  stored: StoredClassification,
): boolean {
  const placement = asStoredPlacement(stored.feedPlacement);
  const ratio = asRatioString(stored.aspectRatio);

  // A row that predates classification carries neither field.
  if (placement === undefined) return ratio === undefined;

  const expected = classifyAspectRatio(ratio);
  return (
    expected.feedPlacement === placement &&
    expected.aspectRatio === (ratio ?? null)
  );
}

/**
 * The patch a classification write applies. `aspectRatio: undefined` clears a
 * stale ratio, which is exactly what Convex `patch` does with `undefined`.
 * `aspectRatioUpdatedAtMs` is stamped only when the classification changed, so
 * a rerun of the backfill is a no-op rather than a write.
 */
export function buildAspectClassificationPatch(
  upsert: AspectClassificationUpsert,
  nowMs: number,
): AspectClassificationFields {
  return {
    aspectRatio: upsert.aspectRatio,
    feedPlacement: upsert.feedPlacement,
    ...(upsert.changed ? { aspectRatioUpdatedAtMs: nowMs } : {}),
  };
}
