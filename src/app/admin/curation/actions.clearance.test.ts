import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { RightsLayer } from "@/generated/prisma/enums";
import { TRIAGE_FACTS } from "@/lib/resale-rights";
import {
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";

/**
 * The clearance server action (ugcportal-qfy9 K1–K3), as an integration
 * test: a real SQLite database with the committed migrations applied, the
 * real Prisma client over the real libsql driver, and the real action. Only
 * the session and Next's navigation/cache helpers are faked.
 *
 * Done this way rather than with a mocked Prisma for the reason
 * actions.test.ts gives next door: the claim under test is partly a claim
 * about the schema — that a clearance really does hang off a MediaListing,
 * that `clearedByUserId` really is a foreign key to User — and a mock would
 * agree with whatever this file asserted.
 *
 * WHAT THIS FILE OWNS AND curation-clearance-write.test.ts DOES NOT: the
 * public entry point. A server action is reachable by POSTing its action id
 * without ever loading the screen, so the session check, the fields the
 * action trusts and the ones it refuses to, and where a refusal sends the
 * admin, are only observable here.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { recordClearance } = await import("@/app/admin/curation/actions");

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
};
const SECOND_ADMIN_SESSION = {
  user: { id: "admin-2", email: "admin2@example.com", role: "ADMIN" },
};
const USER_SESSION = {
  user: { id: "user-1", email: "user@example.com", role: "USER" },
};

/** Every clearable layer answered `true`; the rest answered `false`. */
const ALL_LAYERS_PRESENT = Object.fromEntries(
  TRIAGE_FACTS.map((fact) => [fact.field, fact.settledBy === "clearance"]),
) as Record<string, boolean>;

function clearanceForm(
  overrides: Record<string, string | null> = {},
): FormData {
  const data = new FormData();
  const fields: Record<string, string | null> = {
    mediaId: "media-1",
    layer: RightsLayer.MUSIC,
    reason: "Licence purchased from the rights holder, ref 4412",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) data.set(key, value);
  }
  return data;
}

/** The `?error=` code the action last redirected with, or null. */
function redirectedError(): string | null {
  const target = redirectMock.mock.calls.at(-1)?.[0];
  if (typeof target !== "string") return null;
  return new URL(target, "http://localhost").searchParams.get("error");
}

/** The whole query string of the last redirect, parsed. */
function redirectedParams(): URLSearchParams {
  const target = redirectMock.mock.calls.at(-1)?.[0];
  if (typeof target !== "string") throw new Error("no redirect recorded");
  return new URL(target, "http://localhost").searchParams;
}

async function clearances() {
  return prisma.mediaRightsClearance.findMany({ orderBy: { layer: "asc" } });
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
      { id: "admin-2", email: "admin2@example.com", role: "ADMIN" },
      { id: "user-1", email: "user@example.com", role: "USER" },
      { id: "owner-1", email: "owner@example.com", role: "USER" },
    ],
  });
  await prisma.media.create({
    data: {
      id: "media-1",
      userId: "owner-1",
      kind: "IMAGE",
      key: "media/owner-1/original.jpg",
      previewKey: "previews/owner-1/media-1.webp",
      previewId: "preview-media-1",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      originalName: "original.jpg",
      altText: "A band on a stage",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  authMock.mockReset().mockResolvedValue(ADMIN_SESSION);
  revalidatePathMock.mockReset();
  redirectMock.mockReset();
  await prisma.mediaRightsClearance.deleteMany({});
  await prisma.mediaListing.deleteMany({});
  await prisma.user.update({
    where: { id: "admin-1" },
    data: { role: "ADMIN" },
  });
  await prisma.mediaListing.create({
    data: {
      mediaId: "media-1",
      ...ALL_LAYERS_PRESENT,
      modelReleaseKey: "releases/media-1/release.pdf",
      triagedByUserId: "admin-1",
      triagedAt: new Date("2026-10-02T00:00:00.000Z"),
    },
  });
});

describe("K3: only a current admin may clear a layer", () => {
  it("refuses a signed-out caller and writes nothing", async () => {
    authMock.mockResolvedValue(null);
    await expect(recordClearance(clearanceForm())).rejects.toThrow("Forbidden");
    expect(await clearances()).toEqual([]);
  });

  it("refuses a signed-in non-admin and writes nothing", async () => {
    authMock.mockResolvedValue(USER_SESSION);
    await expect(recordClearance(clearanceForm())).rejects.toThrow("Forbidden");
    expect(await clearances()).toEqual([]);
  });

  it("refuses an admin whose role changed since the session was minted", async () => {
    /*
      The gap a session-only check leaves, as a case. `requireAdmin` reads
      the ROLE OFF THE SESSION, so a session minted before a demotion still
      says ADMIN and sails through it. The write path re-reads the row, and
      that is what refuses — which is why K3's check lives there and not
      only here.
    */
    await prisma.user.update({
      where: { id: "admin-1" },
      data: { role: "USER" },
    });
    await recordClearance(clearanceForm());
    expect(redirectedError()).toBe("clearance_actor_not_admin");
    expect(await clearances()).toEqual([]);
  });

  it("records the SESSION's admin, never an actor from the form", async () => {
    // A form-supplied actor would let a caller sign another admin's name to
    // their own justification. The form here carries both spellings the
    // column and the input use; neither may reach the row.
    await recordClearance(
      clearanceForm({
        clearedByUserId: "admin-2",
        actorUserId: "admin-2",
      }),
    );
    const [row] = await clearances();
    expect(row.clearedByUserId).toBe("admin-1");
  });

  it("follows whichever admin acted, not a constant", async () => {
    await recordClearance(clearanceForm());
    expect((await clearances())[0].clearedByUserId).toBe("admin-1");

    await prisma.mediaRightsClearance.deleteMany({});
    authMock.mockResolvedValue(SECOND_ADMIN_SESSION);
    await recordClearance(clearanceForm());
    expect((await clearances())[0].clearedByUserId).toBe("admin-2");
  });
});

describe("K1: one submission clears one layer", () => {
  it("records the submitted layer and no other", async () => {
    await recordClearance(clearanceForm({ layer: RightsLayer.MINORS }));

    const rows = await clearances();
    expect(rows).toHaveLength(1);
    expect(rows[0].layer).toBe(RightsLayer.MINORS);
  });

  it("records each clearable layer when submitted, one at a time", async () => {
    // The whole table rather than one example: an action that ignored the
    // submitted layer and wrote a constant passes the case above for
    // whichever layer that constant happens to be.
    const submitted = [
      RightsLayer.MUSIC,
      RightsLayer.PEOPLE,
      RightsLayer.MINORS,
      RightsLayer.THIRD_PARTY_CREATOR,
      RightsLayer.SPONSORED_CONTENT,
    ];
    for (const layer of submitted) {
      await recordClearance(clearanceForm({ layer, reason: `For ${layer}` }));
    }
    expect((await clearances()).map((row) => row.layer).sort()).toEqual(
      [...submitted].sort(),
    );
  });

  it("revalidates the screen and redirects back to the row with no error", async () => {
    await recordClearance(clearanceForm());

    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/curation");
    const params = redirectedParams();
    expect(params.get("error")).toBeNull();
    expect(params.get("clearance")).toBe("recorded");
    // Back onto the row the admin was working on, so the next layer's form
    // is already open — the screen renders one upload's forms at a time.
    expect(params.get("edit")).toBe("media-1");
  });
});

describe("what the action refuses before it writes", () => {
  it("throws on a missing media id rather than rendering a banner", async () => {
    // The form carries this in a hidden field on every clearance form, so
    // its absence is a tampered request and not a mistake to explain.
    await expect(
      recordClearance(clearanceForm({ mediaId: null })),
    ).rejects.toThrow("Missing media id");
    expect(await clearances()).toEqual([]);
  });

  it("refuses a layer that is not a RightsLayer at all", async () => {
    await recordClearance(clearanceForm({ layer: "NOT_A_LAYER" }));
    expect(redirectedError()).toBe("clearance_layer_not_clearable");
    expect(await clearances()).toEqual([]);
  });

  it("refuses a missing layer field", async () => {
    await recordClearance(clearanceForm({ layer: null }));
    expect(redirectedError()).toBe("clearance_layer_not_clearable");
    expect(await clearances()).toEqual([]);
  });

  it("refuses ALCOHOL, which is a real layer no clearance settles", async () => {
    /*
      The case a bare `RightsLayer` membership test would let through.
      `depictsAlcohol: true` is final under §3.1a — the standard is what the
      picture looks like — so a row here would be an inert sentence that
      reads, in the register, exactly like one that settles a layer.
    */
    await recordClearance(
      clearanceForm({
        layer: RightsLayer.ALCOHOL,
        reason: "It was grape juice",
      }),
    );
    expect(redirectedError()).toBe("clearance_layer_not_clearable");
    expect(await clearances()).toEqual([]);
  });

  it("refuses WINE_ACCESSORY, which neither answer encumbers", async () => {
    await recordClearance(clearanceForm({ layer: RightsLayer.WINE_ACCESSORY }));
    expect(redirectedError()).toBe("clearance_layer_not_clearable");
    expect(await clearances()).toEqual([]);
  });

  it("refuses a blank reason, and a missing one, with the same code", async () => {
    await recordClearance(clearanceForm({ reason: "   " }));
    expect(redirectedError()).toBe("clearance_reason_blank");

    redirectMock.mockReset();
    await recordClearance(clearanceForm({ reason: null }));
    expect(redirectedError()).toBe("clearance_reason_blank");

    expect(await clearances()).toEqual([]);
  });

  it("refuses a second clearance for a layer that already has one", async () => {
    await recordClearance(clearanceForm({ reason: "The first justification" }));
    authMock.mockResolvedValue(SECOND_ADMIN_SESSION);
    await recordClearance(clearanceForm({ reason: "A different story" }));

    expect(redirectedError()).toBe("clearance_already_recorded");
    const rows = await clearances();
    expect(rows).toHaveLength(1);
    // Not an overwrite: the first admin's words and name are still what the
    // register says.
    expect(rows[0].reason).toBe("The first justification");
    expect(rows[0].clearedByUserId).toBe("admin-1");
  });

  it("sends a refused admin back to the row they were on", async () => {
    await recordClearance(clearanceForm({ reason: "" }));
    expect(redirectedParams().get("edit")).toBe("media-1");
  });

  it("never echoes the submitted reason into the redirect", async () => {
    /*
      `reason` is the one piece of free text on this screen. It goes to the
      column and nowhere else: a refusal that put it back in the URL would
      make it renderable by whatever reads `?error=`, which is the shape
      every outcomes module in this repo is built to avoid.
    */
    const secret = "unique-reason-text-9f2b";
    await recordClearance(
      clearanceForm({ layer: "NOT_A_LAYER", reason: secret }),
    );
    const target = redirectMock.mock.calls.at(-1)?.[0];
    // Anchored first: without this, both `not.toContain`s below would also
    // pass against `undefined` — an action that never redirected at all.
    expect(String(target)).toContain("/admin/curation");
    expect(String(target)).toContain("clearance_layer_not_clearable");
    expect(String(target)).not.toContain(secret);
    expect(decodeURIComponent(String(target))).not.toContain(secret);
  });
});
