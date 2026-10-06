import { type LegalContact } from "@/lib/legal/contact";
import { type LegalPage, createLegalPageLoader, legalPage } from "@/lib/legal/publishable";
import { type LegalProseSection, sectionTexts } from "@/lib/legal/section";
import { LICENCE_PATH } from "@/lib/routes";

/**
 * The licence text, as data (ugcportal-qnq9.4).
 *
 * What a visitor may do with the images on this site (nothing without
 * asking), how to ask, what a buyer of an original will get once there is
 * anything to buy, and what uploading means. Same rule as the privacy
 * statement: a sentence about what the site DOES must point at a file in
 * `reviewAgainst` (a review pointer, not a proof — see
 * src/lib/legal/section.ts); a sentence about terms is policy and carries
 * none.
 *
 * A function of the configured contact (src/lib/legal/contact.ts) rather
 * than a module constant, so a test can hand it a fixture and so the text
 * reflects the environment it renders in.
 *
 * Consistent with docs/ugc-research.md §3.5 ("You own what you create. When
 * you sell UGC, define the usage rights in writing") and with ugcportal-74w,
 * which will add per-item licence terms later: this page is the default that
 * applies when an item states nothing, and it promises no picker that does
 * not exist.
 */

export type LicenceContent = {
  intro: readonly string[];
  sections: readonly LegalProseSection[];
};

export function licenceContent(contact: LegalContact): LicenceContent {
  return {
    intro: [
      "This page says who owns the images and video on this site, what you may do with them, and how to ask for more.",
    ],
    sections: [
      {
        id: "ownership",
        title: "Who owns the work",
        paragraphs: [
          `Everything published here was uploaded by the people who run the site, under accounts only they can hold, and the copyright stays with the person who made it. The rights-holder for licensing questions is ${contact.controllerName}.`,
        ],
        // Allowlisted sign-in: nobody outside the configured list can hold
        // an account, so nobody else can upload.
        reviewAgainst: ["src/lib/sign-in-policy.ts", "src/app/api/media/route.ts"],
      },
      {
        id: "default",
        title: "All rights reserved",
        paragraphs: [
          "Unless an item says otherwise, all rights are reserved. You may look at the images here and share a link to the page. You may not copy, download, crop, re-upload, print, embed, sell, or use them to train a model, in whole or in part, without written permission first. Crediting the site is not a substitute for permission.",
          "What you see on the site is a downscaled, watermarked preview. The original file is not published anywhere on the site.",
        ],
        // Only the watermarked preview is ever served (previewId
        // indirection); the original has no public route.
        reviewAgainst: [
          "src/lib/media-access.ts",
          "src/lib/watermark.ts",
          "src/lib/routes.ts",
        ],
      },
      {
        id: "ask",
        title: "How to ask",
        paragraphs: [
          `E-mail ${contact.contactEmail} with the image (its address on the site is enough), what you want to use it for, where it will appear, for how long, and whether you need it to be exclusive. Permission, when given, is given in writing and covers only what it names.`,
        ],
        reviewAgainst: [],
      },
      {
        id: "buying",
        title: "Buying an original",
        paragraphs: [
          "Nothing is offered for sale yet. An item can only be sold after an administrator has completed and recorded a rights review of the uploader and of that specific item, and no price can be set before that review is done.",
          "When an item is offered, the terms for that item — what you may do with the original, where, for how long, and whether exclusively — will be shown with it before you pay, and this page will be updated first. A purchase grants the use described in those terms; it does not transfer the copyright. Where an item states its own terms, they apply to that item; otherwise this page applies.",
        ],
        // The sellability gate (fail-closed: no review row means not
        // sellable) and the admin-only price endpoint, which answers 422
        // while the gate blocks.
        reviewAgainst: [
          "src/lib/resale-rights.ts",
          "src/app/api/admin/curation/[id]/price/route.ts",
        ],
      },
      {
        id: "uploading",
        title: "What uploading means",
        paragraphs: [
          "Only account holders can upload, and the site has no visitor uploads. Uploading does not transfer copyright to the site; the uploader keeps it. Whether an upload may be sold is a separate decision, recorded by an administrator after the rights review above — uploading something does not make it sellable.",
          "An image that shows a recognisable person is published only with that person's agreement, and is not sold unless a release covering the sale is on file. That is a condition of using the site, not something the upload form can check for you.",
        ],
        reviewAgainst: [
          "src/lib/sign-in-policy.ts",
          "src/lib/resale-rights.ts",
          "prisma/schema.prisma",
        ],
      },
      {
        id: "complaints",
        title: "If something here is yours, or is you",
        paragraphs: [
          `If you believe an image on this site infringes your rights, or shows you and you did not agree, e-mail ${contact.contactEmail} with the image's address on the site and what the problem is. An item can be taken out of the public gallery by its uploader at once while the question is looked at.`,
        ],
        // Unpublish exists (DELETE /api/media/[id]/publish writes
        // publishedAt null); an inbound objection route of its own is
        // ugcportal-qnq9.5.
        reviewAgainst: ["src/app/api/media/[id]/publish/route.ts"],
      },
    ],
  };
}

/** Every string the licence page renders for a given contact. */
export function licenceTexts(content: LicenceContent): string[] {
  return [...content.intro, ...content.sections.flatMap(sectionTexts)];
}

/** The page as the guard sees it, built once at module load — see PRIVACY_PAGE. */
export const LICENCE_PAGE: LegalPage = legalPage(LICENCE_PATH, (contact) =>
  licenceTexts(licenceContent(contact)),
);

/**
 * Content, page and readiness for one request, computed once and cached
 * per request through `createLegalPageLoader` (src/lib/legal/publishable.ts;
 * ugcportal-qnq9.15 item 4) for the same reasons as `loadPrivacy` — see
 * there.
 */
export const loadLicence = createLegalPageLoader(LICENCE_PAGE, licenceContent);
