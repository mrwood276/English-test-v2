// Settings for the v2 project. The publishable key is meant to be public: every table is locked, and all data
// goes through Edge Functions that check who is calling.
export const SUPABASE_URL = "https://lbhnadqmokloyfarrzfv.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E";
export const AUTH_URL = `${SUPABASE_URL}/auth/v1`;
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
export const REQUEST_TIMEOUT_MS = 15000;
export const STAFF_SESSION_KEY = "ENGLISH_TEST_V2_STAFF_SESSION";

// Shown at the bottom of the menu, so it is easy to see which version of the app is loaded.
export const APP_BUILD = "Phase 5, live monitor";
