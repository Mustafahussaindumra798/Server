import test from "node:test";
import assert from "node:assert/strict";
import {
  findExpiringCertificates,
  markCertificateRenewing,
  recordCertificateRenewalResult,
  createAcmeRenewalWorker
} from "../src/ingress/acme-renewal.mjs";

test("findExpiringCertificates queries active certificates nearing expiry", async () => {
  const queries = [];
  const fakeClient = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return {
        rows: [
          {
            id: "10000000-0000-4000-8000-000000000001",
            tenant_id: "20000000-0000-4000-8000-000000000001",
            domain_claim_id: "30000000-0000-4000-8000-000000000001",
            status: "active",
            issuer: "letsencrypt",
            not_after: new Date(Date.now() + 864000000).toISOString(),
            auto_renew: true,
            renewal_attempts: 0,
            hostname: "app.example.com"
          }
        ]
      };
    }
  };

  const expiring = await findExpiringCertificates(fakeClient, { thresholdDays: 30, limit: 10 });
  assert.equal(expiring.length, 1);
  assert.equal(expiring[0].hostname, "app.example.com");
  assert.match(queries[0].sql, /public\.domain_tls_certificates/);
  assert.deepEqual(queries[0].params, [30, 10]);
});

test("markCertificateRenewing transitions certificate to renewing and increments attempts", async () => {
  const queries = [];
  const certId = "10000000-0000-4000-8000-000000000001";
  const fakeClient = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [{ id: certId, status: "renewing", renewal_attempts: 1 }] };
    }
  };

  const marked = await markCertificateRenewing(fakeClient, certId);
  assert.equal(marked.status, "renewing");
  assert.equal(marked.renewal_attempts, 1);
  assert.match(queries[0].sql, /status = 'renewing'/);
  assert.equal(queries[0].params[0], certId);
});

test("recordCertificateRenewalResult updates certificate PEM and resets attempts on success", async () => {
  const queries = [];
  const certId = "10000000-0000-4000-8000-000000000001";
  const fakeClient = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return {
        rows: [{
          id: certId,
          status: "active",
          last_renewed_at: new Date().toISOString(),
          not_after: "2027-01-01T00:00:00Z"
        }]
      };
    }
  };

  const res = await recordCertificateRenewalResult(fakeClient, {
    certId,
    success: true,
    certificatePem: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
    chainPem: "-----BEGIN CERTIFICATE-----\nchain\n-----END CERTIFICATE-----",
    notBefore: "2026-10-01T00:00:00Z",
    notAfter: "2027-01-01T00:00:00Z",
    serialNumber: "1234567890",
    sha256Fingerprint: "a".repeat(64)
  });

  assert.equal(res.status, "active");
  assert.match(queries[0].sql, /last_renewed_at = now\(\)/);
  assert.equal(queries[0].params[1], "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----");
});

test("createAcmeRenewalWorker discovers expiring certs and invokes renewal handler", async () => {
  const certId = "10000000-0000-4000-8000-000000000001";
  let queriesCount = 0;
  const fakePool = {
    async query(sql) {
      queriesCount += 1;
      if (String(sql).includes("JOIN public.domain_claims")) {
        return {
          rows: [{
            id: certId,
            tenant_id: "20000000-0000-4000-8000-000000000001",
            domain_claim_id: "30000000-0000-4000-8000-000000000001",
            status: "active",
            issuer: "letsencrypt",
            not_after: new Date(Date.now() + 864000000).toISOString(),
            auto_renew: true,
            renewal_attempts: 0,
            hostname: "app.example.com"
          }]
        };
      }
      if (String(sql).includes("SET status = 'renewing'")) {
        return { rows: [{ id: certId, status: "renewing", renewal_attempts: 1 }] };
      }
      return { rows: [{ id: certId, status: "active" }] };
    }
  };

  let handlerCalled = false;
  const worker = createAcmeRenewalWorker({
    pool: fakePool,
    thresholdDays: 30,
    renewalHandler: async (cert) => {
      handlerCalled = true;
      assert.equal(cert.hostname, "app.example.com");
      return {
        success: true,
        certificatePem: "cert-pem",
        chainPem: "chain-pem",
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 7776000000).toISOString(),
        serialNumber: "SN999",
        sha256Fingerprint: "b".repeat(64)
      };
    },
    logger: { info() {}, warn() {}, error() {} }
  });

  const result = await worker.checkAndRenew();
  assert.equal(handlerCalled, true);
  assert.equal(result.processed, 1);
  assert.equal(result.renewed, 1);
  assert.equal(result.failed, 0);

  worker.start();
  worker.stop();
});
