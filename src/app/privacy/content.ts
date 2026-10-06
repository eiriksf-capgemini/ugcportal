import { type LegalContact } from "@/lib/legal/contact";
import { type LegalPage, createLegalPageLoader, legalPage } from "@/lib/legal/publishable";
import {
  type LegalListSection,
  type LegalProseSection,
  sectionTexts,
} from "@/lib/legal/section";
import { PRIVACY_PATH } from "@/lib/routes";

/**
 * The privacy statement, as data (ugcportal-qnq9.4).
 *
 * Structured rather than written straight into JSX so that tests can hold
 * every sentence to account: each category names the repository files to
 * re-read when reviewing it (`reviewAgainst` — a pointer that re-prompts
 * human review when a file moves, not a proof; see src/lib/legal/section.ts),
 * each retention line is either a fact the code makes true or an explicit
 * "not yet determined" (never an invented number — ugcportal-yck decides
 * periods, this page only publishes them), and MODEL_COVERAGE maps every
 * Prisma model to a category so a new table cannot appear without someone
 * deciding what this page says about it.
 *
 * A function of the configured contact (src/lib/legal/contact.ts) rather
 * than a module constant, so a test can hand it a fixture and so the text
 * reflects the environment it renders in.
 *
 * English text, Norwegian law: the site is run from Norway, so GDPR applies
 * through personopplysningsloven, cookies through ekomloven § 3-15, and the
 * supervisory authority is Datatilsynet (docs/ugc-research.md §3.4, §5.7).
 *
 * THE RULE FOR EDITING THIS FILE: a sentence about what the site does must be
 * traceable to a file. If the code changes, change the sentence in the same
 * PR. If you cannot point at the file, do not write the sentence.
 */

/** What this page says about how long a kind of data is kept. */
export type Retention =
  | {
      /** A period or trigger the code actually enforces. */
      kind: "stated";
      text: string;
    }
  | {
      /**
       * No period decided yet (ugcportal-yck, gated on ugcportal-alg). The
       * page renders UNDETERMINED_RETENTION_TEXT and then `today`, which
       * describes what happens to the data now — a trigger or "nothing" —
       * and must not itself name a period.
       */
      kind: "undetermined";
      today: string;
    };

export const UNDETERMINED_RETENTION_TEXT =
  "Not yet determined. A retention period for this data has not been decided; when it is, it will be published here.";

/** One data category — the per-category Art. 13 items. */
export type PrivacyCategory = {
  /** Stable id — the section's anchor and the suffix of its `data-testid`. */
  id: string;
  title: string;
  /** Plain-language paragraphs: what is collected and where it lives. */
  what: readonly string[];
  purpose: string;
  legalBasis: string;
  /** Who else sees it, or "No one outside the site." */
  recipients: string;
  retention: Retention;
  /** Who inside the site can read it. */
  access: string;
  /** Review pointers — see LegalProseSection.reviewAgainst. */
  reviewAgainst: readonly string[];
};

export type PrivacyContent = {
  intro: readonly string[];
  controller: LegalProseSection;
  categories: readonly PrivacyCategory[];
  transfers: LegalProseSection;
  cookies: LegalProseSection;
  notDone: LegalListSection;
  rights: LegalProseSection;
};

/** The one place a Retention becomes a sentence, so the K3 test and the page agree. */
export function retentionText(retention: Retention): string {
  return retention.kind === "stated"
    ? retention.text
    : `${UNDETERMINED_RETENTION_TEXT} Today: ${retention.today}`;
}

export function privacyContent(contact: LegalContact): PrivacyContent {
  return {
    intro: [
      "This page says what this website does with personal data: what it collects, why, how long it keeps it, who else sees it, and what you can do about it. It is written from the code that runs the site and checked against it; where a decision has not been made yet, it says so instead of guessing.",
      "Norwegian law applies. The site is run from Norway, so the GDPR applies through personopplysningsloven, cookies are governed by ekomloven § 3-15, and the supervisory authority is Datatilsynet.",
    ],

    // Art. 13(1)(a).
    controller: {
      id: "controller",
      title: "Who is responsible",
      paragraphs: [
        `The data controller is ${contact.controllerName}, a private person running this site from Norway as a hobby. There is no company behind it and no data protection officer, because none is required at this scale.`,
        `Contact: ${contact.contactEmail}.`,
      ],
      reviewAgainst: [],
    },

    categories: [
      {
        id: "visitors",
        title: "If you just browse",
        what: [
          "The site stores nothing about you in its database. The public gallery is read without an account, and the application code does not record your IP address, your browser or what you looked at.",
          `Like every website, the server that answers your request can see your IP address and browser details while it does so. That server is run by ${contact.hostingProvider}. What its access logs keep, and for how long, is a property of the hosting setup rather than of this code.`,
        ],
        purpose: "To show you the gallery, and to keep the server running and secure.",
        legalBasis:
          "Legitimate interest in operating and protecting the site (GDPR Art. 6(1)(f)).",
        recipients: "The hosting provider named above, as the operator of the server.",
        retention: {
          kind: "undetermined",
          today:
            "The application keeps nothing. Whether the host keeps access logs, and for how long, has not been settled.",
        },
        access:
          "Nobody at the site reads visitor data, because none is stored by the application.",
        // The anonymous projection selects nothing about a visitor, and the
        // repository has no code reading x-forwarded-for, remoteAddress or
        // user-agent (asserted mechanically in content.test.ts).
        reviewAgainst: ["src/lib/media-access.ts", "src/lib/public-media.ts"],
      },
      {
        id: "account",
        title: "Account holders: sign-in profile",
        what: [
          "Only a short, fixed list of e-mail addresses may sign in — the people who run the site. Nobody else can create an account, and there are no visitor accounts.",
          "When one of them signs in with Google or Facebook, the site stores the name, e-mail address and profile-picture link that provider supplies, the provider's own account id, and the sign-in tokens the provider issued. It also stores whether the account is an ordinary uploader or an administrator, and when it was created and last changed.",
          "The list of permitted addresses itself is configuration on the server, not a database table.",
        ],
        purpose:
          "To let the people who run the site sign in and upload, and to tell administrators apart from uploaders.",
        legalBasis:
          "Providing the account its holder asked for (GDPR Art. 6(1)(b)), and the site's legitimate interest in keeping uploading closed to a known list (Art. 6(1)(f)).",
        recipients:
          "Google or Facebook, as the sign-in provider you chose — they learn that you signed in here. No one else.",
        retention: {
          kind: "undetermined",
          today:
            "Nothing removes an account automatically. An account is removed by the operator, by hand, on request.",
        },
        access:
          "The account holder, and administrators, who see name, e-mail address and role on the users screen.",
        reviewAgainst: [
          "prisma/schema.prisma",
          "src/lib/auth.ts",
          "src/lib/sign-in-providers.ts",
          "src/lib/sign-in-policy.ts",
          "src/app/admin/settings/users/page.tsx",
          "docs/access-control.md",
        ],
      },
      {
        id: "sessions",
        title: "Account holders: staying signed in",
        what: [
          "After signing in, the browser holds a cookie with a random session token, and the database holds a matching row saying which account it belongs to and when it expires. That is how the site knows it is still you on the next page.",
          "The sign-in library also has a table for e-mail link sign-in. This site offers no such sign-in, so nothing writes to it.",
        ],
        purpose: "To keep an account holder signed in between pages.",
        legalBasis:
          "Strictly necessary for a service the account holder asked for (GDPR Art. 6(1)(b); exempt from consent under ekomloven § 3-15).",
        recipients: "No one outside the site.",
        retention: {
          kind: "stated",
          text: "A session is valid for up to 30 days after it was last used. An expired session is deleted the next time its cookie is presented. Signing out ends it immediately.",
        },
        access: "The account holder's own browser, and the site itself.",
        // Database sessions with the library default of 30 idle days:
        // src/lib/auth.ts (strategy "database", no maxAge override) and
        // docs/access-control.md ("Deploying this does not evict anyone").
        // Expired-on-presentation deletion is @auth/core's session action.
        reviewAgainst: ["src/lib/auth.ts", "docs/access-control.md", "prisma/schema.prisma"],
      },
      {
        id: "uploads",
        title: "Photographs and video",
        what: [
          "Only account holders can upload. For each upload the site keeps the original file exactly as it arrived, a smaller watermarked preview made from it, the original filename, the file type and size, the alt text and caption the uploader wrote, the subject tags they chose, and when it was uploaded and published.",
          "The original file is kept as uploaded. Any information the camera or phone embedded in it — such as location, device details and capture time — stays in that original. The watermarked preview is generated without that embedded information. The original is never shown to the public; the gallery and every image link only ever reach the preview.",
          `The files themselves live in object storage run by ${contact.storageProvider}. The records about them live in the site's database.`,
          "If an item was made in exchange for a benefit — payment, a free or loaned product, a discount or discount code, a trip, or an event invitation — the site also records that a benefit was received, the brand or other source it came from, and the advertising label shown on the item, because Norwegian marketing law requires that kind of post to be clearly labelled as advertising. This record is kept for as long as the item is and is deleted with it; the label is shown publicly on the item, but the brand or other source behind the benefit is not.",
        ],
        purpose:
          "To run the gallery and portfolio, and later to offer originals for sale.",
        legalBasis:
          "The site's legitimate interest in publishing its own work (GDPR Art. 6(1)(f)). For people who appear in an image, see the next section. The advertising-disclosure record rests on the same legitimate interest, in meeting Norway's advertising-labelling rules and being able to show that it has (GDPR Art. 6(1)(f)).",
        recipients:
          "The storage provider named above holds the files. Everyone can see the watermarked preview, alt text, caption, tags, and upload and publication dates of a published item — and, on an item that carries one, its advertising label — and nothing else: not the original, not the filename, not who uploaded it, and not the brand or other source behind a benefit.",
        retention: {
          kind: "stated",
          text: "An item is kept until its uploader deletes it. Deleting removes the database record and then the original and the preview from storage; if storage cannot be reached, the failure is logged and the file is removed by hand. Unpublishing an item hides it but keeps it. There is no automatic expiry.",
        },
        access:
          "The uploader manages their own items; there is no screen on which an administrator browses another account's uploads. The public sees only published previews.",
        reviewAgainst: [
          "src/app/api/media/route.ts",
          "src/lib/watermark.ts",
          "src/lib/media-access.ts",
          "src/app/api/media/[id]/route.ts",
          "src/app/api/media/[id]/publish/route.ts",
          "src/app/api/media/[id]/disclosure/route.ts",
          "src/lib/advertising-disclosure.ts",
          "src/lib/s3.ts",
          "prisma/schema.prisma",
        ],
      },
      {
        id: "depicted",
        title: "People who appear in a photograph or video",
        what: [
          "If you are recognisable in a published image, your likeness is personal data, and so is anything the image shows about you. Before an item can be sold, an administrator records whether it shows identifiable people and, if so, which release covers it; that release is stored as rights evidence (next section).",
          "Only the people who run the site can upload, and the site's policy is to publish only work they made themselves. There are no visitor uploads.",
        ],
        purpose:
          "To publish and, later, sell the site's own work lawfully, and to be able to show that anyone depicted agreed.",
        legalBasis:
          "Your agreement to the publication (åndsverkloven § 104 for a portrait; GDPR Art. 6(1)(a)), and the site's legitimate interest in keeping a record that the agreement exists (Art. 6(1)(f)).",
        recipients:
          "Everyone can see a published preview. A release is seen by administrators only.",
        retention: {
          kind: "undetermined",
          today:
            "The image follows the retention of the item it is in (above). A release stays in storage until removed by hand.",
        },
        access: "The public sees the preview; administrators see the release and the triage record.",
        reviewAgainst: [
          "prisma/schema.prisma",
          "src/lib/rights-evidence.ts",
          "src/lib/resale-rights.ts",
        ],
      },
      {
        id: "rights",
        title: "Rights-clearance records",
        what: [
          "Before anything can be sold, an administrator works through a rights review. The site records, per uploader, the standing decision (its status, how the rights were obtained, who decided, when, until when, and any conditions); per item, the triage answers (people, music, other creators, sponsorship), a price, and who triaged it; and per rights layer, the written justification and who signed it.",
          "Evidence files — signed instruments, model releases, filled-in checklists — are stored under a private prefix in object storage that no public route can reach. Only the storage key and a hash of the file are recorded in the database. Server-side encryption of those files is requested when the deployment is configured for it, and a production server that starts without it logs a warning.",
        ],
        purpose: "To make sure nothing is offered for sale without the rights to sell it.",
        legalBasis:
          "The site's legitimate interest in selling only what it may sell, and in being able to show why (GDPR Art. 6(1)(f)).",
        recipients: "The storage provider holds the evidence files. No one else.",
        retention: {
          kind: "undetermined",
          today:
            "The decision records are deleted with the account they describe. Evidence files are not removed automatically; an unused file is removed when the decision that would have used it fails to save.",
        },
        access: "Administrators only.",
        reviewAgainst: [
          "prisma/schema.prisma",
          "src/lib/rights-evidence.ts",
          "src/lib/resale-rights.ts",
          "src/lib/resale-rights-review.ts",
          "src/app/api/admin/rights/decision/route.ts",
          "src/instrumentation.ts",
        ],
      },
      {
        id: "audit",
        title: "Audit records",
        what: [
          "Two things are written down and never edited: every change of an account's role (who changed whose role, from what to what, with the e-mail addresses copied in), and every change of a rights-clearance status (whose, by whom, why). The e-mail addresses are copied so that the record still makes sense after the account is gone.",
        ],
        purpose: "Accountability: to be able to say who decided what, and when.",
        legalBasis:
          "The site's legitimate interest in an accountable record of its own decisions (GDPR Art. 6(1)(f)).",
        recipients: "No one outside the site.",
        retention: {
          kind: "undetermined",
          today:
            "No code path edits or deletes these records, and they are kept when the account they describe is deleted.",
        },
        access:
          "Administrators see role changes on the users screen. The rights-status history is read only in the database.",
        reviewAgainst: [
          "prisma/schema.prisma",
          "src/lib/roles.ts",
          "src/lib/resale-rights-review.ts",
          "src/app/admin/settings/users/page.tsx",
        ],
      },
      {
        id: "instagram",
        title: "A connected Instagram account",
        what: [
          "An administrator can connect the site's own Instagram account. The site then stores that account's Instagram id and username, an access token encrypted before it is written, when the token expires, what it may do, and which administrator connected it. This concerns the operators' own account, not visitors.",
        ],
        purpose:
          "To find the site's own Instagram posts, as an aid to choosing what to publish here.",
        legalBasis: "The account holder's own request to connect it (GDPR Art. 6(1)(b)).",
        recipients: "Meta (Instagram), whose interface the connection talks to.",
        retention: {
          kind: "undetermined",
          today:
            "Removed when the administrator who connected it is removed. Not removed on any schedule.",
        },
        access: "Administrators.",
        reviewAgainst: [
          "prisma/schema.prisma",
          "src/lib/crypto.ts",
          "src/lib/instagram.ts",
          "src/app/api/admin/instagram/callback/route.ts",
        ],
      },
      {
        id: "logs",
        title: "What the application writes to its log",
        what: [
          "When a sign-in is refused, the log records the domain of the e-mail address (the part after the @) and which provider was used — never the full address. When processing, storing or deleting a file fails, the log records the uploader's account id, the item's id or the storage key (which contains that account id), and the error. The application writes no IP addresses and no browser details to its log.",
        ],
        purpose: "To let the operator find out why something failed.",
        legalBasis: "Legitimate interest in running the site (GDPR Art. 6(1)(f)).",
        recipients: "The hosting provider, wherever the server's output is kept.",
        retention: {
          kind: "undetermined",
          today:
            "Where log output goes and how long it is kept is a property of the hosting setup.",
        },
        access: "The operator.",
        reviewAgainst: [
          "src/lib/sign-in-policy.ts",
          "src/app/api/media/route.ts",
          "src/app/api/media/[id]/route.ts",
          "src/lib/rights-evidence.ts",
        ],
      },
    ],

    // Art. 13(1)(e)-(f).
    transfers: {
      id: "transfers",
      title: "Where the data is",
      paragraphs: [
        `The site's database runs on the server operated by ${contact.hostingProvider}. Uploaded files and rights evidence are in object storage operated by ${contact.storageProvider}.`,
        "Google and Meta are US companies. When an account holder signs in through Google or Facebook, or an administrator connects the site's Instagram account, that part of the processing happens with them under their own privacy terms.",
      ],
      reviewAgainst: ["src/lib/s3.ts", "src/lib/sign-in-providers.ts"],
    },

    // The consent position as the code makes it true: the banner, the
    // consent cookie and the gated loader are ugcportal-3wgp (PR #92); the
    // analytics tool itself is only present in a deployment that sets the
    // loader's two NEXT_PUBLIC_UMAMI_* variables (env.example).
    cookies: {
      id: "cookies",
      title: "Cookies and consent",
      paragraphs: [
        "If you only browse and have not answered the cookie banner, this site sets no cookies of its own and loads no analytics, advertising or social-media scripts.",
        "Cookies appear when someone signs in: the sign-in library sets a few security cookies (a CSRF token, the OAuth state, and the address to return to) while the sign-in is in progress, and a session cookie afterwards (see “staying signed in” above). An administrator connecting an Instagram account gets a ten-minute cookie that ties the Instagram reply to the request that started it. These are strictly necessary, and no consent is asked for them.",
        "Visitor analytics, where a deployment has it switched on, uses Umami and loads only after you accept it on the consent banner. Nothing optional is set or loaded before you choose, and declining takes the same single click as accepting. Your answer is remembered in one first-party cookie of this site's own (ugc_cookie_consent, kept for a year), which holds nothing but the answer. You can change or withdraw the choice at any time from the “Cookies” link, and withdrawing stops the script from loading again.",
        "That is what ekomloven § 3-15 requires: GDPR-standard, active consent for anything that is not strictly necessary.",
      ],
      // No cookie is written outside Auth.js, the Instagram state cookie
      // and the consent cookie (grep for cookies()/Set-Cookie/document.cookie
      // in src/, asserted in content.test.ts); the layout mounts no script
      // of its own, only the consent-gated AnalyticsLoader (layout.tsx,
      // analytics-loader.tsx).
      reviewAgainst: [
        "src/lib/auth.ts",
        "src/lib/instagram-oauth-state.ts",
        "src/lib/consent.ts",
        "src/components/consent/cookie-banner.tsx",
        "src/components/consent/analytics-loader.tsx",
        "src/app/layout.tsx",
      ],
    },

    // Each a thing a reader might otherwise assume.
    notDone: {
      id: "not-done",
      title: "What this site does not do today",
      items: [
        "No visitor uploads, comments or accounts.",
        "No newsletter and no contact form; contact is by e-mail.",
        "No sales and no payment processing yet.",
        "No advertising or affiliate tracking, and no visitor analytics unless you have accepted it on the cookie banner in a deployment that has it switched on.",
        "No profiling and no automated decisions about anyone.",
        "No transfer of visitor data anywhere, because none is collected.",
      ],
      paragraphs: [
        "If any of these changes, this statement is updated first, and anything that needs your consent will ask for it before it starts.",
      ],
      reviewAgainst: [
        "src/app/layout.tsx",
        "src/components/consent/analytics-loader.tsx",
        "src/lib/media-access.ts",
      ],
    },

    // Art. 13(2)(b)-(d): rights, withdrawal, complaint.
    rights: {
      id: "your-rights",
      title: "Your rights",
      paragraphs: [
        "You can ask what personal data the site holds about you, have it corrected or deleted, have its use restricted, object to it, receive a copy of data you provided, and withdraw a consent you gave. Withdrawing consent does not affect what was done before you withdrew it.",
        `To use any of these rights, e-mail ${contact.contactEmail}. You will get an answer within one month. Account holders can delete their own uploads directly; deleting an account is done by hand on request, because there is no self-service for it yet.`,
        "If you think the site handles your personal data unlawfully, you can complain to the Norwegian Data Protection Authority, Datatilsynet (datatilsynet.no, postkasse@datatilsynet.no). You are welcome to raise it with us first, but you do not have to.",
      ],
      reviewAgainst: ["src/app/api/media/[id]/route.ts", "docs/access-control.md"],
    },
  };
}

/**
 * Every model in prisma/schema.prisma, and which category above describes
 * it — or an explicit statement that it holds no personal data. The test
 * parses the schema and fails on a model missing from this map, so adding a
 * table forces a decision about this page (K2).
 */
export const MODEL_COVERAGE: Readonly<
  Record<string, { category: string } | { notPersonalData: string }>
> = {
  User: { category: "account" },
  Account: { category: "account" },
  Session: { category: "sessions" },
  VerificationToken: { category: "sessions" },
  Media: { category: "uploads" },
  Tag: {
    notPersonalData:
      "Subject labels (food, books, ...), shared across items; nothing about a person.",
  },
  InstagramAccount: { category: "instagram" },
  RoleChange: { category: "audit" },
  ResaleRightsReview: { category: "rights" },
  ResaleRightsEvent: { category: "audit" },
  MediaListing: { category: "rights" },
  MediaRightsClearance: { category: "rights" },
  // The advertising disclosure sits with the uploads rather than with the
  // rights records, even though MediaListing.sponsoredContent looks similar:
  // that one answers "may this be RESOLD" for an administrator, and this one
  // is the uploader's own declaration about their own item, deleted with the
  // item (ugcportal-qnq9.1).
  //
  // The category's prose now names this record: the uploads category's
  // fourth `what` paragraph says what is recorded (that a benefit was
  // received, its source, and the advertising label) and why, its
  // `legalBasis` carries the matching sentence, and its `recipients` says
  // the label is public but the benefit's source is not (ugcportal-mj50).
  // That sentence changed the uploads category's authored text, so
  // LEGAL_SIGN_OFF (src/lib/legal/contact.ts) was re-recorded against the
  // new digest in the same change. The label itself — not this record, and
  // not benefitReceived or the brand's name — is public, rendered on the
  // gallery tile, the lightbox, the per-item page and the public feed JSON
  // (ugcportal-e0jv, part B).
  MediaAdvertisingDisclosure: { category: "uploads" },
  BenefitSource: {
    notPersonalData:
      "Brand names (the company behind a paid or gifted item), shared across items so a brand is one row rather than one per item; a company, not a visitor or an account holder.",
  },
};

/**
 * The prose sections, in page order. The ONE enumeration (round 4): the
 * tests and `privacyTexts` both read this, so a sixth section added here is
 * scanned, and one added anywhere else fails the test that every section
 * the page renders is in the texts.
 */
export function privacyProseSections(content: PrivacyContent): LegalProseSection[] {
  return [content.controller, content.transfers, content.cookies, content.notDone, content.rights];
}

/** Every string the privacy page renders for a given contact. */
export function privacyTexts(content: PrivacyContent): string[] {
  return [
    ...content.intro,
    ...content.categories.flatMap((category) => [
      category.title,
      ...category.what,
      category.purpose,
      category.legalBasis,
      category.recipients,
      retentionText(category.retention),
      category.access,
    ]),
    ...privacyProseSections(content).flatMap(sectionTexts),
  ];
}

/**
 * The page as the guard sees it — route and authored prose — built once at
 * module load from the sentinel contact (round 4: the authored text is
 * invariant, so it is not rebuilt per request).
 */
export const PRIVACY_PAGE: LegalPage = legalPage(PRIVACY_PATH, (contact) =>
  privacyTexts(privacyContent(contact)),
);

/**
 * What a request needs: the content for the configured contact, the page,
 * and its readiness — computed once here, so `generateMetadata`, the
 * component and its guard all read the same result.
 *
 * `createLegalPageLoader` (src/lib/legal/publishable.ts; ugcportal-qnq9.15
 * item 4) wraps this in React's `cache` (the same idiom as `getSession` in
 * src/lib/auth.ts) so `generateMetadata` and the page component, which both
 * call this with no arguments during one request, share one build rather
 * than two. Outside a server-component render — tests, the boot check —
 * `cache` is a pass-through, which is why the tests can change the stubbed
 * environment between calls.
 */
export const loadPrivacy = createLegalPageLoader(PRIVACY_PAGE, privacyContent);
