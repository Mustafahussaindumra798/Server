import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseAuthVerifier } from "../src/auth/supabase.mjs";
import { AuthenticationError } from "../src/auth/oidc.mjs";

const supabaseUrl = "https://project-ref.supabase.co";
const apiKey = "sb_publishable_test_key";

test("verifies Supabase access tokens through the Auth user endpoint", async () => {
  let request;
  const verify = createSupabaseAuthVerifier({
    supabaseUrl, apiKey,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { status: 200, ok: true, json: async () => ({ id: "user-123", email: "owner@example.test" }) };
    }
  });
  const principal = await verify("valid.access.token");
  assert.equal(request.url, supabaseUrl + "/auth/v1/user");
  assert.equal(request.options.headers.apikey, apiKey);
  assert.equal(request.options.headers.authorization, "Bearer valid.access.token");
  assert.equal(principal.identitySubject, supabaseUrl + "/auth/v1|user-123");
  assert.equal(principal.claims.email, "owner@example.test");
});

test("rejects invalid and expired Supabase sessions", async () => {
  const verify = createSupabaseAuthVerifier({
    supabaseUrl, apiKey,
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) })
  });
  await assert.rejects(() => verify("invalid.token"), AuthenticationError);
});

test("reports Auth provider outages as service unavailable", async () => {
  const verify = createSupabaseAuthVerifier({
    supabaseUrl, apiKey,
    fetchImpl: async () => { throw new Error("network unavailable"); }
  });
  await assert.rejects(async () => verify("valid.access.token"), (error) => error instanceof AuthenticationError && error.status === 503);
});

test("requires a valid HTTPS Supabase URL and public API key", () => {
  assert.throws(() => createSupabaseAuthVerifier({ supabaseUrl: "http://project-ref.supabase.co", apiKey }));
  assert.throws(() => createSupabaseAuthVerifier({ supabaseUrl, apiKey: "" }));
});


test("reuses a short-lived verified principal for frequent dashboard polls", async () => {
  let calls = 0;
  const verify = createSupabaseAuthVerifier({
    supabaseUrl, apiKey,
    fetchImpl: async () => {
      calls += 1;
      return { status: 200, ok: true, json: async () => ({ id: "cached-user", email: "cached@example.test" }) };
    }
  });
  const first = await verify("same.valid.token");
  const second = await verify("same.valid.token");
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});


test("does not cache verification when a caller requires fresh authorization", async () => {
  let calls = 0;
  const verify = createSupabaseAuthVerifier({
    supabaseUrl, apiKey,
    fetchImpl: async () => {
      calls += 1;
      return { status: 200, ok: true, json: async () => ({ id: "fresh-user" }) };
    }
  });
  await verify("fresh.valid.token", { cache: false });
  await verify("fresh.valid.token", { cache: false });
  assert.equal(calls, 2);
});
