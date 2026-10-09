import { Role } from "@/generated/prisma/enums";

/**
 * WHO MAY PUBLISH AT ALL (ugcportal-9gt1).
 *
 * The failure this exists to prevent, stated once: somebody is added to
 * `ALLOWED_SIGNIN_EMAILS` so that they can upload, and discovers that they
 * can also put their own photographs on the public gallery — with no code
 * change, no review, and nobody having decided it.
 *
 * Until this module, that was the live rule. `POST /api/media/[id]/publish`
 * asked `requireOwnedMedia`, which answers "is this row yours"; it asked
 * nothing about who the caller is. Eirik decided on 2026-10-09 that only he
 * and Gry publish and sell, "for now, open later". SELLING already enforced
 * that — `POST /api/admin/curation/[id]/price` calls `requireAdmin` — and
 * publishing enforced it only in the sense that the permitted set happened
 * to contain exactly those two people. A restriction that holds because of
 * the current contents of a configuration value, rather than because
 * anything checks it, is not a restriction; it is a coincidence with a
 * deployment date.
 *
 * This is `ugcportal-egp` one layer down. That bead existed because no bead
 * owned *who may have an account at all*, and the answer turned out to be
 * "anyone on the internet with a Google account". The same question about
 * *who may publish* is answered here, and it is answered while the answer is
 * still two people and therefore cheap to write down.
 *
 * ---------------------------------------------------------------------------
 * IS "MAY PUBLISH" THE SAME SET AS "IS AN ADMIN"? TODAY YES, AND NOT BY
 * ACCIDENT THAT IT IS A SEPARATE FUNCTION.
 * ---------------------------------------------------------------------------
 *
 * `isPublishOperator` below is `role === ADMIN` and nothing else, so as of
 * this commit the two sets are identical and this module adds no third
 * concept to configure. That is deliberate: inventing a `PUBLISH_EMAILS`
 * environment variable, or a second role column, would be answering a
 * product question ("who, specifically?") that is out of this bead's scope
 * and that `ADMIN_BOOTSTRAP_EMAILS` plus the admin UI already answer.
 *
 * What is NOT the same is the QUESTION, which is why the route calls this
 * and not `requireAdmin`. "Is an admin" means, today, the whole back office:
 * changing other people's roles, signing rights clearances, setting prices,
 * editing brand records and Instagram credentials. "May publish" is a
 * narrower, more frequent and far less dangerous act. The likely shape of
 * Eirik's "open later" is a third person who may publish their own uploads
 * and may not change anyone's role or sign a clearance on a stranger's face
 * — i.e. the publish set widening while the admin set does not. If the route
 * had simply called `requireAdmin`, that day's change would be a hunt for
 * every call site that happened to mean "publisher" when it said "admin",
 * with no way to tell them apart. With this seam it is an edit to one
 * function and its tests.
 *
 * The converse — an admin who may not publish — is not a case anybody wants.
 * An admin can already price an item, clear a face and change a role;
 * withholding the visibility switch from them would be theatre, not a
 * restriction. So the two sets are expected to diverge in exactly one
 * direction, and this function is where that divergence will be written.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 *
 * Who is an operator in fact — the contents of `ADMIN_BOOTSTRAP_EMAILS` and
 * of the `User.role` column — is configuration and an admin screen, not
 * this module. Whether self-service publishing is the right model at all is
 * `ugcportal-55nt` and is still open; this adds a condition to publishing,
 * which is the safer direction under either answer. Unpublishing is NOT
 * gated here: see the publish route's DELETE handler for why withdrawing an
 * item from the public gallery stays available to its owner.
 */

/**
 * Why a publish was refused for a reason about the CALLER rather than about
 * the row.
 *
 * A closed set with a full `Record` of messages below, so a second code
 * added here fails `tsc` until it has a sentence — the same construction
 * `PUBLISH_BLOCKERS` (src/lib/publishability.ts) and `TRIAGE_WRITE_REFUSALS`
 * use.
 *
 * SEPARATE FROM `PublishBlocker`, which is this module's whole point. Those
 * codes are facts about the upload — no attestation, an uncleared face, a
 * retired declaration version — and every one of them names something the
 * owner or an administrator can go and fix about that item. This one is a
 * fact about the account making the request, and no amount of work on the
 * row changes it. Folding it into that set would put "you are not permitted
 * to do this" into an enum whose every other member means "this material is
 * not ready", and the rights gate's own 422 ("the records make this
 * impossible") would start covering a case that is an ordinary 403.
 */
export const PUBLISH_AUTHORITY_BLOCKERS = ["not_an_operator"] as const;

export type PublishAuthorityBlocker =
  (typeof PUBLISH_AUTHORITY_BLOCKERS)[number];

/**
 * The sentence the caller is shown.
 *
 * It says what happened to their upload, because the thing a refused
 * uploader most needs to know is that nothing was lost: the file is stored,
 * it is theirs, and the only missing step is somebody else's. It deliberately
 * does not name the operators or say how one is appointed — that is
 * configuration, and a refusal message is a poor place to publish an
 * instance's staffing.
 */
export const PUBLISH_AUTHORITY_BLOCKER_MESSAGES: Record<
  PublishAuthorityBlocker,
  string
> = {
  not_an_operator:
    "Publishing to the public gallery is restricted to this site's operators. Your upload is stored and unchanged; an operator has to publish it.",
};

/**
 * The refusal body, in the same `{ error, blocker }` shape
 * `publishRightsRefusal` answers with — one shape for the two refusals that
 * carry a closed-set code rather than a form field.
 */
export type PublishAuthorityRefusal = {
  readonly error: string;
  readonly blocker: PublishAuthorityBlocker;
};

/**
 * May this account publish?
 *
 * The parameter is the ROLE, not a session, and not a user id. A role is
 * what the session callback in src/lib/auth.ts re-reads from the `User` row
 * on every single request (`role: toRole(user)`), so passing it here keeps
 * this function pure and keeps the answer as fresh as that read — a
 * demotion takes effect on the demoted operator's next request, with nothing
 * here to invalidate. Taking a session instead would make this module await
 * one, which is a second session read on a path that has already done one,
 * and would give it a "nobody is signed in" branch that its only caller has
 * already ruled out.
 *
 * `null`/`undefined` is refused rather than treated as "unknown, ask
 * someone": a gate that cannot see a role has not established one, and the
 * direction this must fail in is closed.
 */
export function isPublishOperator(role: Role | null | undefined): boolean {
  return role === Role.ADMIN;
}

/**
 * `null` when this account may publish, otherwise the body to answer 403
 * with.
 *
 * Mirrors `publishRightsRefusal`, `advertisingLabelPublishRefusal` and
 * `commercialPublishRefusal`: the decision is a pure function of its input
 * and the route owns the status code.
 */
export function publishOperatorRefusal(
  role: Role | null | undefined,
): PublishAuthorityRefusal | null {
  if (isPublishOperator(role)) {
    return null;
  }
  return {
    error: PUBLISH_AUTHORITY_BLOCKER_MESSAGES.not_an_operator,
    blocker: "not_an_operator",
  };
}
