import { AuthenticationError } from "./oidc.mjs";

export function createSupabaseAuthVerifier({ supabaseUrl, apiKey, fetchImpl = fetch }) {
  if (!supabaseUrl || !apiKey) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) are required.");
  let base;
  try {
    base = new URL(supabaseUrl);
    if (base.protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    throw new Error("SUPABASE_URL must be a valid HTTPS URL.");
  }
  const issuer = base.origin + base.pathname.replace(/\/$/, "") + "/auth/v1";

  return async function verifySupabaseAccessToken(token) {
    if (typeof token !== "string" || token.length > 16384 || !/^[A-Za-z0-9._~-]+$/.test(token)) {
      throw new AuthenticationError("Invalid access token.");
    }
    let response;
    try {
      response = await fetchImpl(issuer + "/user", {
        method: "GET",
        headers: { apikey: apiKey, authorization: "Bearer " + token, accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      });
    } catch {
      throw new AuthenticationError("Supabase Auth is temporarily unavailable.", 503);
    }
    if (response.status === 401 || response.status === 403) throw new AuthenticationError("Invalid or expired access token.");
    if (!response.ok) throw new AuthenticationError("Supabase Auth is temporarily unavailable.", 503);
    let user;
    try { user = await response.json(); } catch { throw new AuthenticationError("Supabase Auth returned an invalid response.", 503); }
    if (!user || typeof user.id !== "string" || !user.id.trim()) throw new AuthenticationError("Invalid access token.");
    return {
      issuer,
      subject: user.id,
      identitySubject: issuer + "|" + user.id,
      claims: { sub: user.id, iss: issuer, email: typeof user.email === "string" ? user.email : null }
    };
  };
}
