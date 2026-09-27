// Route paths shared across modules that can't import each other freely —
// notably the "use server" actions file, which may only export async
// functions, and src/lib/instagram.ts, which route tests mock wholesale.
export const INSTAGRAM_SETTINGS_PATH = "/admin/settings/instagram";
export const INSTAGRAM_CALLBACK_PATH = "/api/admin/instagram/callback";
export const INSTAGRAM_CONNECT_PATH = "/api/admin/instagram/connect";
export const ADMIN_USERS_PATH = "/admin/settings/users";
// Resale rights (ugcportal-0ss, re-anchored to uploaders by ugcportal-vsm).
// Not under /instagram any more: a connected account confers no right to
// sell anything, and the screen lists uploaders.
export const RIGHTS_SETTINGS_PATH = "/admin/settings/rights";
// A route handler rather than a server action, so the evidence upload can
// have its own body cap instead of raising the global one (ugcportal-0ss).
export const RIGHTS_DECISION_PATH = "/api/admin/rights/decision";
