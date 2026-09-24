import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * What this process is actually allowed to use, read from the cgroup rather
 * than inferred from the machine (ugcportal-e86).
 *
 * The distinction matters because everything Node exposes describes the
 * *host*: os.totalmem() is the machine's RAM, and os.availableParallelism()
 * reads the affinity mask — neither notices `--memory` or `--cpus`. A
 * container limited to 1 GB and 2 CPUs on a 64-core, 256 GB host sees 256 GB
 * and 64 through those APIs, so anything sized from them is sized for a
 * machine this process cannot have. The kernel publishes the real numbers;
 * this module reads them.
 */

/**
 * The `source` is part of every return value on purpose: "2 GB, because the
 * cgroup says so" and "2 GB, because that is how much RAM the host happens to
 * have and nobody set a limit" are the same number with completely different
 * levels of trust, and a caller sizing a resource pool from it should be able
 * to log which one it got.
 */
export type LimitSource = "cgroup-v2" | "cgroup-v1" | "host";

export interface MemoryBudget {
  bytes: number;
  source: LimitSource;
}

export interface CpuBudget {
  /**
   * Effective CPUs. Rounded *down* to a whole number and floored at 1,
   * because the consumers of this are thread counts: a 1.5-CPU quota cannot
   * usefully run two compute threads, and rounding up would reintroduce the
   * over-provisioning this exists to remove.
   */
  cpus: number;
  source: LimitSource;
}

/** cgroup v2. Contains either a byte count or the literal "max". */
const CGROUP_V2_MEMORY_MAX = "/sys/fs/cgroup/memory.max";

/**
 * cgroup v1. "Unlimited" is expressed as a sentinel close to 2^63 rather than
 * a word, which is why the sanity check below is against host RAM and not
 * against a magic constant: the exact sentinel has varied between kernels
 * (PAGE_COUNTER_MAX scaled by the page size), while "the limit is larger than
 * the machine" identifies all of them.
 */
const CGROUP_V1_MEMORY_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

/**
 * cgroup v2 CPU. One line, "$MAX $PERIOD" in microseconds, e.g.
 * "200000 100000" for `--cpus=2`; $MAX is the literal "max" when unlimited.
 */
const CGROUP_V2_CPU_MAX = "/sys/fs/cgroup/cpu.max";

/** cgroup v1 CPU. Quota is -1 when unlimited; period defaults to 100000. */
const CGROUP_V1_CPU_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const CGROUP_V1_CPU_PERIOD = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";

export type FileReader = (path: string) => string | undefined;

/** Reads a small pseudo-file, treating every failure as "not present". */
const readPseudoFile: FileReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

function parsePositive(raw: string | undefined): number | undefined {
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
 * Falls back to host RAM when no cgroup limit is visible — running outside a
 * container, or in one started without `--memory`. That fallback is
 * deliberately *not* silent: `source: "host"` tells the caller the number is
 * an upper bound on what the machine has, not a promise about what this
 * process may use, and on a shared host it will over-provision anything sized
 * from it. src/lib/watermark.ts warns when it sees it, on the first image
 * upload (that is when it configures its gate — not at process start).
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
  const v2 = parsePositive(readFile(CGROUP_V2_MEMORY_MAX));
  if (v2 !== undefined && v2 <= totalMemBytes) {
    return { bytes: v2, source: "cgroup-v2" };
  }

  const v1 = parsePositive(readFile(CGROUP_V1_MEMORY_LIMIT));
  if (v1 !== undefined && v1 <= totalMemBytes) {
    return { bytes: v1, source: "cgroup-v1" };
  }

  return { bytes: totalMemBytes, source: "host" };
}

/**
 * The container's CPU budget, in whole effective CPUs.
 *
 * The sibling of {@link detectMemoryBudget}, and needed for the same reason:
 * `docker run --cpus=2` is a CFS bandwidth quota, not a cpuset, so it does
 * not narrow the affinity mask and os.availableParallelism() keeps reporting
 * the host's core count. Sizing a thread pool from that number on a quota-
 * limited container buys no throughput — the scheduler throttles the process
 * to its quota regardless — and costs memory per thread.
 *
 * A cpuset-limited container *is* already handled by
 * os.availableParallelism(), which is why that remains the fallback and the
 * ceiling here.
 */
export function detectCpuBudget(
  readFile: FileReader = readPseudoFile,
  hostCpus: number = os.availableParallelism?.() ?? os.cpus().length,
): CpuBudget {
  const ceiling = Math.max(1, Math.floor(hostCpus));

  const v2 = readFile(CGROUP_V2_CPU_MAX)?.trim().split(/\s+/);
  if (v2 && v2.length >= 2) {
    const quota = parsePositive(v2[0]);
    const period = parsePositive(v2[1]);
    if (quota !== undefined && period !== undefined) {
      return {
        cpus: Math.min(ceiling, Math.max(1, Math.floor(quota / period))),
        source: "cgroup-v2",
      };
    }
  }

  const quota = parsePositive(readFile(CGROUP_V1_CPU_QUOTA));
  const period = parsePositive(readFile(CGROUP_V1_CPU_PERIOD));
  if (quota !== undefined && period !== undefined) {
    return {
      cpus: Math.min(ceiling, Math.max(1, Math.floor(quota / period))),
      source: "cgroup-v1",
    };
  }

  return { cpus: ceiling, source: "host" };
}
