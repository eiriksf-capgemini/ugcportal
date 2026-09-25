/**
 * Prisma's error code for a thrown value, or undefined if it carries none.
 *
 * Matched on the documented `code` string rather than
 * `instanceof PrismaClientKnownRequestError`: the driver adapter re-wraps
 * errors, and an instanceof check that crosses module instances is a coin
 * flip.
 *
 * Shared because two call sites now need it — the review writer and the
 * price endpoint — and a second hand-rolled `(error as {code?: unknown})`
 * would be a second place to get the narrowing subtly wrong.
 */
export function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The codes that mean "a row moved underneath this write", as opposed to a
 * fault. Named here so both callers describe the same races with the same
 * words.
 *
 *   P2002 unique violation  — someone else created the row first
 *   P2003 foreign key       — a row this write points at was deleted
 *   P2025 record not found  — the row being updated was deleted
 *
 * Nothing outside this set is caught anywhere: a disk error answered with a
 * tidy "try again" is a fault that never gets looked at.
 */
export const PRISMA_UNIQUE_VIOLATION = "P2002";
export const PRISMA_FOREIGN_KEY_VIOLATION = "P2003";
export const PRISMA_RECORD_NOT_FOUND = "P2025";
