import { describe, expect, it } from "vitest";

import { detectMemoryBudget } from "@/lib/memory-budget";

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
