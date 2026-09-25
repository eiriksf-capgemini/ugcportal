import { describe, expect, it } from "vitest";

import { detectCpuBudget, detectMemoryBudget } from "@/lib/container-limits";

const GiB = 1024 * 1024 * 1024;
const HOST = 16 * GiB;

/** A fake /sys/fs/cgroup, so these run identically on macOS and in CI. */
function fakeCgroup(files: Record<string, string>) {
  return (path: string) => files[path];
}

const V2 = "/sys/fs/cgroup/memory.max";
const V1 = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

describe("detectMemoryBudget", () => {
  it("prefers the cgroup v2 limit", () => {
    expect(
      detectMemoryBudget(fakeCgroup({ [V2]: `${2 * GiB}\n` }), HOST),
    ).toEqual({ bytes: 2 * GiB, source: "cgroup-v2" });
  });

  it("falls back to cgroup v1 when v2 is absent", () => {
    expect(
      detectMemoryBudget(fakeCgroup({ [V1]: `${GiB}\n` }), HOST),
    ).toEqual({ bytes: GiB, source: "cgroup-v1" });
  });

  it("treats cgroup v2's literal 'max' as no limit", () => {
    expect(detectMemoryBudget(fakeCgroup({ [V2]: "max\n" }), HOST)).toEqual({
      bytes: HOST,
      source: "host",
    });
  });

  it("ignores a v2 'max' in favour of a real v1 limit", () => {
    // A hybrid host can expose both hierarchies; "unlimited here" must not
    // shadow "limited there".
    expect(
      detectMemoryBudget(
        fakeCgroup({ [V2]: "max", [V1]: `${512 * 1024 * 1024}` }),
        HOST,
      ),
    ).toEqual({ bytes: 512 * 1024 * 1024, source: "cgroup-v1" });
  });

  it("rejects a limit larger than the machine", () => {
    // cgroup v1 spells "unlimited" as a near-2^63 sentinel whose exact value
    // has varied between kernels, so the check is "bigger than host RAM"
    // rather than a magic number.
    expect(
      detectMemoryBudget(fakeCgroup({ [V1]: "9223372036854771712" }), HOST),
    ).toEqual({ bytes: HOST, source: "host" });
  });

  it("falls back to host RAM when the files are unreadable", () => {
    expect(detectMemoryBudget(() => undefined, HOST)).toEqual({
      bytes: HOST,
      source: "host",
    });
  });

  it("ignores empty and non-numeric contents", () => {
    for (const raw of ["", "   \n", "not-a-number", "0", "-1"]) {
      expect(detectMemoryBudget(fakeCgroup({ [V2]: raw }), HOST).source).toBe(
        "host",
      );
    }
  });

  it("reads the real cgroup files without throwing", () => {
    // No assertion on the value: this is a macOS workstation as often as it
    // is a Linux container. What matters is that the production code path
    // (real readFileSync, real ENOENT) returns a usable budget rather than
    // propagating an error into module initialisation.
    const budget = detectMemoryBudget();
    expect(budget.bytes).toBeGreaterThan(0);
    expect(["cgroup-v2", "cgroup-v1", "host"]).toContain(budget.source);
  });
});

const CPU_V2 = "/sys/fs/cgroup/cpu.max";
const CPU_V1_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const CPU_V1_PERIOD = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";

describe("detectCpuBudget", () => {
  it("reads a cgroup v2 CFS quota that the affinity mask does not show", () => {
    // `docker run --cpus=2` on a 64-core host. This is the whole point of the
    // function: os.availableParallelism() reports 64 here, because a
    // bandwidth quota is not a cpuset and does not narrow the mask.
    expect(detectCpuBudget(fakeCgroup({ [CPU_V2]: "200000 100000\n" }), 64)).toEqual(
      { cpus: 2, source: "cgroup-v2" },
    );
  });

  it("treats a v2 quota of 'max' as unlimited", () => {
    expect(detectCpuBudget(fakeCgroup({ [CPU_V2]: "max 100000" }), 8)).toEqual({
      cpus: 8,
      source: "host",
    });
  });

  it("reads the cgroup v1 quota/period pair", () => {
    expect(
      detectCpuBudget(
        fakeCgroup({ [CPU_V1_QUOTA]: "400000", [CPU_V1_PERIOD]: "100000" }),
        64,
      ),
    ).toEqual({ cpus: 4, source: "cgroup-v1" });
  });

  it("falls back to the kernel's default v1 period when it is unreadable", () => {
    // Round-8 finding 3: the code required both files and so discarded a
    // perfectly good quota when only the period was missing, falling back to
    // host cores inside a quota-limited container — the exact blind spot
    // this function exists to close. The quota carries the information; the
    // period is 100000µs unless someone changed it.
    expect(
      detectCpuBudget(fakeCgroup({ [CPU_V1_QUOTA]: "200000" }), 64),
    ).toEqual({ cpus: 2, source: "cgroup-v1" });
  });

  it("prefers an explicitly set v1 period over the default", () => {
    // A non-default period must still win, or the fallback would quietly
    // misreport every container that tunes it.
    expect(
      detectCpuBudget(
        fakeCgroup({ [CPU_V1_QUOTA]: "200000", [CPU_V1_PERIOD]: "50000" }),
        64,
      ),
    ).toEqual({ cpus: 4, source: "cgroup-v1" });
  });

  it("treats the v1 -1 sentinel as unlimited", () => {
    expect(
      detectCpuBudget(
        fakeCgroup({ [CPU_V1_QUOTA]: "-1", [CPU_V1_PERIOD]: "100000" }),
        8,
      ),
    ).toEqual({ cpus: 8, source: "host" });
  });

  it("rounds a fractional quota down, never below one", () => {
    // --cpus=1.5 cannot usefully run two compute threads; rounding up would
    // reintroduce the over-provisioning this exists to remove.
    expect(detectCpuBudget(fakeCgroup({ [CPU_V2]: "150000 100000" }), 8).cpus).toBe(1);
    expect(detectCpuBudget(fakeCgroup({ [CPU_V2]: "50000 100000" }), 8).cpus).toBe(1);
  });

  it("never reports more CPUs than the affinity mask allows", () => {
    // A cpuset-limited container is already reflected in hostCpus, and a
    // quota larger than the cpuset cannot be spent.
    expect(
      detectCpuBudget(fakeCgroup({ [CPU_V2]: "6400000 100000" }), 2).cpus,
    ).toBe(2);
  });

  it("falls back to the affinity mask when no quota is visible", () => {
    expect(detectCpuBudget(() => undefined, 10)).toEqual({
      cpus: 10,
      source: "host",
    });
  });

  it("ignores a malformed cpu.max line", () => {
    for (const raw of ["", "max", "garbage here", "100000"]) {
      expect(detectCpuBudget(fakeCgroup({ [CPU_V2]: raw }), 8).source).toBe(
        "host",
      );
    }
  });

  it("reads the real cgroup files without throwing", () => {
    const cpu = detectCpuBudget();
    expect(cpu.cpus).toBeGreaterThanOrEqual(1);
    expect(["cgroup-v2", "cgroup-v1", "host"]).toContain(cpu.source);
  });
});
