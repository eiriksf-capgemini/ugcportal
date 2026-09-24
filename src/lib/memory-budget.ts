import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * How much memory this process is actually allowed to use, and where that
 * number came from (ugcportal-e86).
 *
 * The `source` is part of the return value on purpose: "2 GB, because the
 * cgroup says so" and "2 GB, because that is how much RAM the host happens to
 * have and nobody set a limit" are the same number with completely different
 * levels of trust, and a caller sizing a resource pool from it should be able
 * to log which one it got.
 */
export interface MemoryBudget {
  bytes: number;
  source: "cgroup-v2" | "cgroup-v1" | "host";
}

/** cgroup v2. The file contains either a byte count or the literal "max". */
const CGROUP_V2_MEMORY_MAX = "/sys/fs/cgroup/memory.max";

/**
 * cgroup v1. "Unlimited" is expressed as a sentinel close to 2^63 rather than
 * a word, which is why the sanity check below is against host RAM and not
 * against a magic constant: the exact sentinel has varied between kernels
 * (PAGE_COUNTER_MAX scaled by the page size), while "the limit is larger than
 * the machine" identifies all of them.
 */
const CGROUP_V1_MEMORY_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

export type FileReader = (path: string) => string | undefined;

/** Reads a small pseudo-file, treating every failure as "not present". */
const readPseudoFile: FileReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "max") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * The container's memory budget, in bytes.
 *
 * Read from the cgroup rather than guessed, because a guess is exactly what
 * this is supposed to replace: the point of the caller (the watermark
 * concurrency gate) is to size a native-memory pool against the budget the
 * kernel will actually OOM-kill us for exceeding, and the kernel publishes
 * that number.
 *
 * Falls back to host RAM when no cgroup limit is visible — running outside a
 * container, or in one started without `--memory`. That fallback is
 * deliberately *not* silent: `source: "host"` tells the caller the number is
 * an upper bound on what the machine has, not a promise about what this
 * process may use, and on a shared host it will over-provision anything sized
 * from it. The fix for that is to set a memory limit on the container (see
 * the Dockerfile) or to override the derived value explicitly.
 *
 * A cgroup limit above host RAM is also treated as absent: the kernel allows
 * it, but it cannot be honoured, and taking it at face value would produce a
 * budget larger than the machine.
 *
 * The readers are injectable so this can be tested without a container; in
 * production both default to the real thing.
 */
export function detectMemoryBudget(
  readFile: FileReader = readPseudoFile,
  totalMemBytes: number = os.totalmem(),
): MemoryBudget {
  const v2 = parseLimit(readFile(CGROUP_V2_MEMORY_MAX));
  if (v2 !== undefined && v2 <= totalMemBytes) {
    return { bytes: v2, source: "cgroup-v2" };
  }

  const v1 = parseLimit(readFile(CGROUP_V1_MEMORY_LIMIT));
  if (v1 !== undefined && v1 <= totalMemBytes) {
    return { bytes: v1, source: "cgroup-v1" };
  }

  return { bytes: totalMemBytes, source: "host" };
}
