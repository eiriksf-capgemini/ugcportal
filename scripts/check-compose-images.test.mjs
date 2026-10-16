import { describe, expect, it } from "vitest";
import { parseRef, parseServices, run } from "./check-compose-images.mjs";

const MIXED = `
services:
  db:
    image: quay.io/example/db:1.0
  migrate:
    image: ugcportal-migrate:\${UGCPORTAL_IMAGE_TAG:-dev}
  builder:
    build: .
    image: local-built:latest
  app:
    image: ugcportal:\${UGCPORTAL_IMAGE_TAG:-dev}
volumes:
  data:
`;

const ONE_OF_EACH = `
services:
  cache:
    image: redis:7
  builder:
    image: local-built:latest
    build:
      context: .
  app:
    image: ugcportal:\${TAG}
`;

const ALL_EXCLUDED = `
services:
  builder:
    build: .
  app:
    image: ugcportal:\${TAG}
`;

function stub(statusFor) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).includes("/manifests/")) return { status: statusFor(String(url)) };
    return { status: 200, json: async () => ({ token: "anon" }) };
  };
  return { fetchImpl, calls };
}

async function exec(composeText, fetchImpl) {
  const lines = [];
  const code = await run({ composeText, fetchImpl, out: (s) => lines.push(s) });
  return { code, lines };
}

describe("check-compose-images", () => {
  it("excludes build-local and ${VAR} images by name and checks only the registry image", async () => {
    const { fetchImpl, calls } = stub(() => 200);
    const { code, lines } = await exec(ONE_OF_EACH, fetchImpl);
    expect(code).toBe(0);
    expect(lines).toContain("EXCLUDED build-local: service builder (local-built:latest)");
    expect(lines).toContain("EXCLUDED unresolved-var: service app (ugcportal:${TAG})");
    const manifestCalls = calls.filter((c) => c.url.includes("/manifests/"));
    expect(manifestCalls).toHaveLength(1);
    expect(manifestCalls[0].url).toBe("https://registry-1.docker.io/v2/library/redis/manifests/7");
    expect(lines.some((l) => l.startsWith("OK   200 redis:7"))).toBe(true);
  });

  it("fails non-zero when every image is excluded", async () => {
    const { fetchImpl, calls } = stub(() => 200);
    const { code, lines } = await exec(ALL_EXCLUDED, fetchImpl);
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/no registry images were checked/);
  });

  it("fails on a 401 and names the image and status", async () => {
    const { fetchImpl } = stub(() => 401);
    const { code, lines } = await exec(MIXED, fetchImpl);
    expect(code).not.toBe(0);
    expect(lines).toContain("FAIL 401 quay.io/example/db:1.0 (service db)");
  });

  it("guardrail: resolves over HTTP (token then manifest HEAD), never docker pull", async () => {
    const { fetchImpl, calls } = stub(() => 200);
    await exec(MIXED, fetchImpl);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].url).toMatch(/^https:\/\/quay\.io\/v2\/auth/);
    const head = calls.find((c) => c.url.includes("/manifests/"));
    expect(head).toEqual({ url: "https://quay.io/v2/example/db/manifests/1.0", method: "HEAD" });
    // The script has no child_process import at all, so no pull can be spawned.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./check-compose-images.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/child_process|execSync|spawn/);
  });

  it("supports digest refs and the real compose file shape", () => {
    expect(parseRef("bitnamilegacy/minio:2025.4.8@sha256:abc")).toEqual({
      host: "docker.io",
      repo: "bitnamilegacy/minio",
      reference: "sha256:abc",
    });
    expect(parseRef("ghcr.io/o/r:v1")).toEqual({ host: "ghcr.io", repo: "o/r", reference: "v1" });
    expect(parseServices(MIXED).map((s) => s.name)).toEqual(["db", "migrate", "builder", "app"]);
  });
});
