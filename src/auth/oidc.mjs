import { createPublicKey, verify as verifySignature } from "node:crypto";

export class AuthenticationError extends Error {
  constructor(message = "Authentication required.", status = 401) {
    super(message);
    this.name = "AuthenticationError";
    this.status = status;
  }
}

function decodeJson(segment) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new AuthenticationError("Invalid access token.");
  }
}

export function createOidcVerifier({ issuer, audience, jwksUri, fetchImpl = fetch, clock = () => Date.now() }) {
  if (!issuer || !audience || !jwksUri) {
    throw new Error("OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI are required.");
  }
  try {
    if (new URL(issuer).protocol !== "https:" || new URL(jwksUri).protocol !== "https:") {
      throw new Error("OIDC issuer and JWKS endpoints must use HTTPS.");
    }
  } catch {
    throw new Error("OIDC_ISSUER and OIDC_JWKS_URI must be valid HTTPS URLs.");
  }

  let cachedKeys = [];
  let expiresAt = 0;

  async function getKey(kid, forceRefresh = false) {
    if (forceRefresh || clock() >= expiresAt || !cachedKeys.some((key) => key.kid === kid)) {
      let response;
      try {
        response = await fetchImpl(jwksUri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      } catch {
        throw new AuthenticationError("Identity provider is temporarily unavailable.", 503);
      }
      if (!response.ok) throw new AuthenticationError("Identity provider is temporarily unavailable.", 503);
      let document;
      try { document = await response.json(); } catch { throw new AuthenticationError("Identity provider returned invalid signing keys.", 503); }
      if (!Array.isArray(document.keys)) throw new AuthenticationError("Identity provider returned invalid signing keys.", 503);
      cachedKeys = document.keys.filter((key) => key && key.kty === "RSA" && key.use !== "enc" && (!key.alg || key.alg === "RS256") && typeof key.kid === "string");
      expiresAt = clock() + 5 * 60 * 1000;
    }
    const jwk = cachedKeys.find((key) => key.kid === kid);
    if (!jwk) throw new AuthenticationError("Invalid access token.");
    try { return createPublicKey({ key: jwk, format: "jwk" }); }
    catch { throw new AuthenticationError("Invalid access token."); }
  }

  return async function verifyAccessToken(token) {
    if (typeof token !== "string" || token.length > 16384) throw new AuthenticationError("Invalid access token.");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AuthenticationError("Invalid access token.");
    const header = decodeJson(parts[0]);
    const claims = decodeJson(parts[1]);
    if (!header || typeof header !== "object" || Array.isArray(header) ||
        !claims || typeof claims !== "object" || Array.isArray(claims)) {
      throw new AuthenticationError("Invalid access token.");
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new AuthenticationError("Unsupported access token.");
    const key = await getKey(header.kid);
    let valid = false;
    try {
      valid = verifySignature("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url"));
    } catch {
      valid = false;
    }
    if (!valid) throw new AuthenticationError("Invalid access token.");

    const now = Math.floor(clock() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audiences.includes(audience) ||
        typeof claims.sub !== "string" || !claims.sub.trim() ||
        !Number.isFinite(claims.exp) || claims.exp <= now - 30 ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30))) {
      throw new AuthenticationError("Invalid or expired access token.");
    }
    if (audiences.length > 1 && claims.azp !== audience) throw new AuthenticationError("Invalid access token.");
    return { issuer: claims.iss, subject: claims.sub, identitySubject: claims.iss + "|" + claims.sub, claims };
  };
}

export function getBearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") throw new AuthenticationError();
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(header);
  if (!match) throw new AuthenticationError();
  return match[1];
}
