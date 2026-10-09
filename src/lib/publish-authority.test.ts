import { describe, expect, it } from "vitest";

import { Role } from "@/generated/prisma/enums";
import { PUBLISH_BLOCKERS } from "@/lib/publishability";
import {
  PUBLISH_AUTHORITY_BLOCKERS,
  PUBLISH_AUTHORITY_BLOCKER_MESSAGES,
  isPublishOperator,
  publishOperatorRefusal,
} from "@/lib/publish-authority";

/**
 * The decision itself (ugcportal-9gt1). Its behaviour in the publish route —
 * the 403, where it sits relative to the ownership gate and the rights
 * gate, and that widening the sign-in allowlist does not satisfy it — is in
 * src/app/api/media/[id]/publish/route.test.ts. What is here is the
 * function's own contract, including the two properties a caller is entitled
 * to assume and would not notice losing: that an absent role is refused, and
 * that the codes this answers with cannot collide with the rights gate's.
 */
describe("isPublishOperator", () => {
  it("admits an admin", () => {
    expect(isPublishOperator(Role.ADMIN)).toBe(true);
  });

  it("refuses an ordinary user", () => {
    expect(isPublishOperator(Role.USER)).toBe(false);
  });

  it.each([null, undefined])("refuses a missing role (%s)", (role) => {
    // Fail CLOSED. A gate that cannot see a role has not established one,
    // and "unknown" must not read as "probably fine" on the path that puts
    // material in front of the public and, through the sitemap, in front of
    // search engines.
    expect(isPublishOperator(role)).toBe(false);
  });
});

describe("publishOperatorRefusal", () => {
  it("answers null for an operator, so the route falls through to its other gates", () => {
    expect(publishOperatorRefusal(Role.ADMIN)).toBeNull();
  });

  it("answers the closed-set code and its own sentence for everybody else", () => {
    expect(publishOperatorRefusal(Role.USER)).toEqual({
      blocker: "not_an_operator",
      error: PUBLISH_AUTHORITY_BLOCKER_MESSAGES.not_an_operator,
    });
  });

  it("does not name an operator, or how one is appointed, in the sentence it shows", () => {
    // The message reaches whoever was refused. Staffing and configuration
    // are not a refusal's to publish; what it owes them is the state of
    // their upload.
    const { error } = publishOperatorRefusal(Role.USER)!;
    expect(error).not.toMatch(/@/);
    expect(error).not.toMatch(/ADMIN_BOOTSTRAP_EMAILS|ALLOWED_SIGNIN_EMAILS/);
    expect(error).toMatch(/stored and unchanged/);
  });
});

describe("the blocker set", () => {
  it("has a message for every code", () => {
    expect(Object.keys(PUBLISH_AUTHORITY_BLOCKER_MESSAGES).sort()).toEqual(
      [...PUBLISH_AUTHORITY_BLOCKERS].sort(),
    );
  });

  it("shares no code with the rights gate's set", () => {
    // The two sets travel in the same `blocker` field of the same route's
    // responses, and they mean different things — this one is about the
    // account and no work on the row changes it, those are about the
    // material and every one of them names something to go and fix. A
    // client branching on `blocker` must never see one and act on the
    // other.
    const shared = PUBLISH_AUTHORITY_BLOCKERS.filter((code) =>
      (PUBLISH_BLOCKERS as readonly string[]).includes(code),
    );
    expect(shared).toEqual([]);
  });
});
