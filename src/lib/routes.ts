// Route paths shared across modules that can't import each other freely —
// notably the "use server" actions file, which may only export async
// functions, and src/lib/instagram.ts, which route tests mock wholesale.
export const INSTAGRAM_SETTINGS_PATH = "/admin/settings/instagram";
export const INSTAGRAM_CALLBACK_PATH = "/api/admin/instagram/callback";
export const INSTAGRAM_CONNECT_PATH = "/api/admin/instagram/connect";
