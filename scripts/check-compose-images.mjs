#!/usr/bin/env node
// Anonymous image-resolution gate for docker-compose.yml (ugcportal-vtgz).
//
// Usage: node scripts/check-compose-images.mjs [compose-file] [--local-image <name>]...
//
// `${VAR:-default}` and `${VAR-default}` are expanded to the default before
// classification (the default text in the compose file; process.env is not consulted). For every service
// it then classifies the image as
//   registry              -> resolved with an anonymous token and a manifest HEAD
//   local (build)         -> the service has a `build:` key; no registry has it
//   local (allowlist)     -> the image name (last path segment, no tag/digest) is on the
//                            local-image allowlist: ugcportal and ugcportal-migrate are
//                            built locally yet carry no `build:` key. `--local-image <name>`
//                            (repeatable) adds names to it. The allowlist is printed in the
//                            reach line so a silent exclusion is visible.
//   unresolved-var        -> a ${VAR} with no default remains, so it names no registry image
// Exclusions are printed by name. Exit is non-zero on any non-200 or when
// the set of registry images checked is empty (a gate that checked nothing
// must not read as a pass).
//
// It never runs `docker pull`: a warm local cache would satisfy that and hide
// a registry that stopped serving anonymously (the 2026-10-14 MinIO failure).
// Resolution is an HTTP request every time.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// Minimal reader for the two keys we need. Compose files here are plain
// block YAML: services at indent 2, their keys at indent 4.
export function parseServices(text) {
  const services = [];
  let inServices = false;
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services:\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inServices) continue;
    if (indent === 2) {
      const m = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
      current = m ? { name: m[1], image: null, build: false } : null;
      if (current) services.push(current);
    } else if (indent === 4 && current) {
      const im = line.match(/^ {4}image:\s*(.+?)\s*$/);
      if (im) current.image = im[1].replace(/^["']|["']$/g, "");
      if (/^ {4}build:/.test(line)) current.build = true;
    }
  }
  return services;
}

export const DEFAULT_LOCAL_IMAGES = ["ugcportal", "ugcportal-migrate"];

// ${VAR:-default} and ${VAR-default} -> default. A ${VAR} with no default is left in place.
export function expandDefaults(image) {
  return image.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, "$1");
}

// "reg.io/ns/name:tag@sha256:..." -> "name"
export function imageName(image) {
  const noDigest = image.split("@")[0];
  const lastSlash = noDigest.lastIndexOf("/");
  const base = noDigest.slice(lastSlash + 1);
  const colon = base.indexOf(":");
  return colon >= 0 ? base.slice(0, colon) : base;
}

export function classify(svc, localImages = DEFAULT_LOCAL_IMAGES) {
  if (svc.build) return { ...svc, kind: "local (build)" };
  if (!svc.image) return { ...svc, kind: "no-image" };
  const expanded = expandDefaults(svc.image);
  if (expanded.includes("${")) return { ...svc, kind: "unresolved-var" };
  if (localImages.includes(imageName(expanded))) return { ...svc, kind: "local (allowlist)", image: expanded };
  return { ...svc, kind: "registry", image: expanded };
}

// "repo[:tag][@sha256:...]" with an optional registry host first.
export function parseRef(image) {
  let rest = image;
  let digest = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = null;
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split("/");
  let host = "docker.io";
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) {
    host = parts.shift();
  }
  let repo = parts.join("/");
  if (host === "docker.io" && !repo.includes("/")) repo = `library/${repo}`;
  // A digest pins the content; the tag is informational when both are given.
  const reference = digest ?? tag ?? "latest";
  return { host, repo, reference };
}

function endpoints({ host, repo }) {
  if (host === "docker.io" || host === "index.docker.io" || host === "registry-1.docker.io") {
    return {
      registry: "registry-1.docker.io",
      tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
    };
  }
  if (host === "quay.io") {
    return { registry: "quay.io", tokenUrl: `https://quay.io/v2/auth?service=quay.io&scope=repository:${repo}:pull` };
  }
  if (host === "ghcr.io") {
    return { registry: "ghcr.io", tokenUrl: `https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull` };
  }
  return null;
}

export async function resolveImage(image, fetchImpl) {
  const ref = parseRef(image);
  const ep = endpoints(ref);
  if (!ep) return { status: null, detail: `unsupported registry host ${ref.host}` };
  const headers = { Accept: MANIFEST_ACCEPT };
  try {
    const tokRes = await fetchImpl(ep.tokenUrl);
    if (tokRes.status === 200) {
      const body = await tokRes.json();
      const token = body.token ?? body.access_token;
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    // A token endpoint refusal is not fatal here: the manifest HEAD below
    // reports the status that matters.
    const url = `https://${ep.registry}/v2/${ref.repo}/manifests/${ref.reference}`;
    const res = await fetchImpl(url, { method: "HEAD", headers });
    return { status: res.status, detail: "" };
  } catch (err) {
    return { status: null, detail: `request failed: ${err.message}` };
  }
}

export async function run({
  composeText,
  fetchImpl = fetch,
  localImages = [],
  out = (s) => process.stdout.write(`${s}\n`),
}) {
  const allowlist = [...new Set([...DEFAULT_LOCAL_IMAGES, ...localImages])];
  const services = parseServices(composeText).map((svc) => classify(svc, allowlist));
  const excluded = services.filter((s) => s.kind !== "registry");
  const checked = services.filter((s) => s.kind === "registry");
  out(`compose services found: ${services.length}`);
  out(`local-image allowlist: ${allowlist.join(", ")}`);
  for (const s of excluded) {
    out(`EXCLUDED ${s.kind}: service ${s.name} (${s.image ?? "no image"})`);
  }
  let failures = 0;
  for (const s of checked) {
    const r = await resolveImage(s.image, fetchImpl);
    if (r.status === 200) {
      out(`OK   200 ${s.image} (service ${s.name})`);
    } else {
      failures++;
      out(`FAIL ${r.status ?? "no-status"} ${s.image} (service ${s.name})${r.detail ? ` ${r.detail}` : ""}`);
    }
  }
  out(`registry images checked: ${checked.length}, excluded: ${excluded.length}, failed: ${failures}`);
  if (checked.length === 0) {
    out("FAIL no registry images were checked; refusing to report a pass on an empty set");
    return 1;
  }
  return failures > 0 ? 1 : 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  const localImages = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--local-image") {
      if (!args[i + 1]) {
        process.stderr.write("--local-image needs a name\n");
        process.exit(2);
      }
      localImages.push(args[++i]);
    } else positional.push(args[i]);
  }
  const path = positional[0] ?? "docker-compose.yml";
  process.exitCode = await run({ composeText: readFileSync(path, "utf8"), localImages });
}
