"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { attestationFormParts } from "@/lib/attestation";
import { mediaAttestationApiPath } from "@/lib/routes";

import { AttestationFields } from "./attestation-questions";
import {
  type AttestationDraft,
  completedAttestation,
  emptyAttestationDraft,
  setAttestationAnswer,
  setAttestationAuthorship,
} from "./attestation-fields";

/**
 * The rights questions for ONE file that was stored without them
 * (ugcportal-gkax), on that file's own row in the upload queue.
 *
 * WHO SEES IT. A configured uploader is not asked the questions before
 * upload (ugcportal-ho7j), so their upload is stored with no attestation, and
 * the sale gate refuses it as `attestation_missing` until its uploader
 * answers — nobody else may answer for them (§4 item 7). The queue row
 * renders this only when the upload's own 201 said `attested: false`; see
 * `QueueMedia.attested`. Every row in this queue is the signed-in visitor's
 * own upload, and the route re-checks that anyway: an id that is not theirs
 * is a 403.
 *
 * WHERE, AND THE GAP THAT LEAVES. The upload queue is the only page on
 * which an owner sees their own uploads at this commit (GET /api/media lists
 * them, but no page renders that list), and it is component state that
 * empties when the page is left (ugcportal-smk). A file uploaded in an earlier visit
 * therefore has nowhere to be answered from until the owner's library page
 * exists (ugcportal-bk57). Not built here.
 *
 * THE SAME NINE QUESTIONS AS THE UPLOAD FORM, through the same
 * `AttestationFields` block and the same `completedAttestation`, sent as the
 * same `attestationFormParts` the upload's multipart body carries — as JSON
 * this time, to a route that hands them to the same `parseAttestation`.
 * Stamped with the version this page rendered, for the reason
 * `completedAttestation` gives.
 *
 * ONCE. The answers cannot be changed afterwards (the route answers 409),
 * and the block says so before the visitor sends them.
 *
 * Has state of its own, unlike the list it sits in: what the visitor has
 * ticked, whether the block is open, and how the request went belong to this
 * one file and to nothing the queue's reducer tracks.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "failed"; message: string }
  | { kind: "done"; message: string };

const RECORDED = "Your rights answers for this file are recorded.";

/**
 * The sentence for a response that is not a 201. Exported for the test that
 * pins each status's wording without mounting anything.
 */
export function attestationFailureMessage(
  status: number,
  serverError: string | null,
): string {
  switch (status) {
    case 400:
      // The route's own sentence: a missing answer names the question, a
      // stale version says to reload. Both are written for this visitor.
      return serverError ?? "Your answers were not accepted. Reload the page and try again.";
    case 401:
      return "You are signed out. Sign in again in another tab, then try again.";
    case 403:
    case 404:
      return "This file is not one you can answer for.";
    default:
      return "Your answers could not be recorded. Try again.";
  }
}

async function errorOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const error = (body as Record<string, unknown>).error;
      if (typeof error === "string" && error !== "") return error;
    }
  } catch {
    // Not JSON: there is no sentence of the server's to show.
  }
  return null;
}

export function AttestExistingUpload({
  mediaId,
  fileName,
}: {
  mediaId: string;
  fileName: string;
}) {
  const panelId = useId();
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AttestationDraft>(emptyAttestationDraft);
  const [refused, setRefused] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  /*
   * When the answers are recorded, the toggle and the whole block unmount —
   * including the button that was just pressed — and focus would fall to
   * <body> (the same handoff ugcportal-ff2a does for the queue's own
   * self-unmounting controls). It lands on the sentence that replaced them.
   */
  useEffect(() => {
    if (phase.kind === "done") statusRef.current?.focus();
  }, [phase.kind]);

  if (phase.kind === "done") {
    return (
      <p
        ref={statusRef}
        tabIndex={-1}
        role="status"
        data-attest-existing-upload-done=""
        className="mt-2 rounded-sm text-xs text-ink outline-hidden focus:ring-3 focus:ring-ring/80"
      >
        {phase.message}
      </p>
    );
  }

  async function submit() {
    const submission = completedAttestation(draft);
    if (submission === null) {
      setRefused(true);
      return;
    }
    setPhase({ kind: "sending" });
    let response: Response;
    try {
      response = await fetch(mediaAttestationApiPath(mediaId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(attestationFormParts(submission))),
      });
    } catch {
      setPhase({
        kind: "failed",
        message: "Your answers could not be sent. Check your connection and try again.",
      });
      return;
    }
    if (response.status === 201) {
      setPhase({ kind: "done", message: RECORDED });
      return;
    }
    const serverError = await errorOf(response);
    if (response.status === 409) {
      // Already on record — from another tab, or a double send. Nothing is
      // left to answer, so the block is finished either way.
      setPhase({
        kind: "done",
        message:
          serverError ?? "This file already has rights answers on record.",
      });
      return;
    }
    setPhase({
      kind: "failed",
      message: attestationFailureMessage(response.status, serverError),
    });
  }

  const sending = phase.kind === "sending";

  return (
    <div className="mt-2" data-attest-existing-upload-row="">
      <p className="text-xs text-ink">
        Stored without your rights answers, so it cannot be offered for sale.
      </p>
      <Button
        type="button"
        variant="outline-neutral"
        size="sm"
        className="mt-2"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Hide the rights questions" : "Answer the rights questions"}
        <span className="sr-only"> for {fileName}</span>
      </Button>
      {open ? (
        /*
          ON THE PAGE CANVAS, not on the row's own bg-surface-1 well: the
          questions are the upload form's block, whose text tokens
          (text-foreground / text-muted-foreground) are the ones measured for
          --background (src/lib/design/dual-meaning-usage.test.ts). Giving the
          panel that background keeps them correct here rather than adding a
          second colouring of the same nine questions.
        */
        <div
          id={panelId}
          data-attest-existing-upload-panel=""
          className="mt-3 rounded-md border border-line bg-background p-4"
        >
          <AttestationFields
            draft={draft}
            refused={refused}
            legend="Your rights in this file"
            intro={
              "Only you can answer these, and they are recorded once, against this file, " +
              "and cannot be changed afterwards. Answer honestly — a wrong answer here is " +
              "something the operator may act on. If you answer that someone identifiable " +
              "is shown, a published file comes off the public pages until an operator " +
              "clears it; if you answer that you hold no rights to it, it stays off them."
            }
            refusalEnding="recording them"
            marker="data-attest-existing-upload"
            onAuthorshipChange={(value) =>
              setDraft((current) => setAttestationAuthorship(current, value))
            }
            onAnswerChange={(field, value) =>
              setDraft((current) => setAttestationAnswer(current, field, value))
            }
          />
          {/* Rendered unconditionally, empty when there is nothing to say,
              so it is announced rather than silently inserted. */}
          <p role="alert" className="mt-3 text-xs text-destructive">
            {phase.kind === "failed" ? phase.message : ""}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            disabled={sending}
            onClick={() => void submit()}
          >
            {sending ? "Recording…" : "Record my answers"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
