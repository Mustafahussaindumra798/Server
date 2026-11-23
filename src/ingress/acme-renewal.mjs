/**
 * ACME Certificate Renewal Worker
 * Automatically discovers expiring domain certificates, manages renewal state transitions,
 * and records renewed certificates or renewal errors.
 */

export async function findExpiringCertificates(client, { thresholdDays = 30, limit = 50 } = {}) {
  const result = await client.query(`
    SELECT
      cert.id,
      cert.tenant_id,
      cert.domain_claim_id,
      cert.status,
      cert.issuer,
      cert.not_after,
      cert.auto_renew,
      cert.renewal_attempts,
      claim.hostname
    FROM public.domain_tls_certificates AS cert
    JOIN public.domain_claims AS claim ON claim.id = cert.domain_claim_id AND claim.tenant_id = cert.tenant_id
    WHERE cert.status IN ('active', 'issuing')
      AND cert.auto_renew = true
      AND (cert.not_after IS NULL OR cert.not_after < clock_timestamp() + ($1 * interval '1 day'))
      AND claim.status = 'verified'
    ORDER BY cert.not_after ASC NULLS FIRST, cert.renewal_attempts ASC
    LIMIT $2
  `, [thresholdDays, limit]);
  return result.rows;
}

export async function markCertificateRenewing(client, certId) {
  const result = await client.query(`
    UPDATE public.domain_tls_certificates
    SET status = 'renewing',
        renewal_attempts = renewal_attempts + 1,
        updated_at = now()
    WHERE id = $1 AND status IN ('active', 'issuing')
    RETURNING id, status, renewal_attempts
  `, [certId]);
  return result.rows[0] || null;
}

export async function recordCertificateRenewalResult(client, {
  certId,
  success,
  certificatePem = null,
  chainPem = null,
  notBefore = null,
  notAfter = null,
  serialNumber = null,
  sha256Fingerprint = null,
  errorMessage = null
}) {
  if (success) {
    const result = await client.query(`
      UPDATE public.domain_tls_certificates
      SET status = 'active',
          certificate_pem = $2,
          chain_pem = $3,
          not_before = $4,
          not_after = $5,
          serial_number = $6,
          sha256_fingerprint = $7,
          last_renewed_at = now(),
          renewal_attempts = 0,
          updated_at = now()
      WHERE id = $1
      RETURNING id, status, last_renewed_at, not_after
    `, [certId, certificatePem, chainPem, notBefore, notAfter, serialNumber, sha256Fingerprint]);
    return result.rows[0] || null;
  }

  const result = await client.query(`
    UPDATE public.domain_tls_certificates
    SET status = CASE WHEN not_after IS NOT NULL AND not_after < clock_timestamp() THEN 'expired' ELSE 'active' END,
        updated_at = now()
    WHERE id = $1
    RETURNING id, status, renewal_attempts
  `, [certId]);
  return result.rows[0] || null;
}

export function createAcmeRenewalWorker({
  pool,
  thresholdDays = 30,
  checkIntervalMs = 60_000,
  renewalHandler = async () => ({ success: true }),
  logger = console
} = {}) {
  let timer = null;
  let running = false;

  async function checkAndRenew() {
    if (!pool || running) return { processed: 0, renewed: 0, failed: 0 };
    running = true;
    let processed = 0;
    let renewed = 0;
    let failed = 0;

    try {
      const expiring = await findExpiringCertificates(pool, { thresholdDays });
      for (const cert of expiring) {
        processed += 1;
        const marked = await markCertificateRenewing(pool, cert.id);
        if (!marked) continue;

        logger.info?.(`Attempting ACME certificate renewal for ${cert.hostname}`, {
          cert_id: cert.id,
          hostname: cert.hostname,
          attempt: marked.renewal_attempts
        });

        let outcome;
        try {
          outcome = await renewalHandler(cert);
        } catch (handlerErr) {
          outcome = { success: false, errorMessage: handlerErr.message };
        }

        if (outcome?.success) {
          await recordCertificateRenewalResult(pool, {
            certId: cert.id,
            success: true,
            certificatePem: outcome.certificatePem,
            chainPem: outcome.chainPem,
            notBefore: outcome.notBefore,
            notAfter: outcome.notAfter,
            serialNumber: outcome.serialNumber,
            sha256Fingerprint: outcome.sha256Fingerprint
          });
          renewed += 1;
          logger.info?.(`ACME certificate renewed successfully for ${cert.hostname}`, { cert_id: cert.id });
        } else {
          await recordCertificateRenewalResult(pool, {
            certId: cert.id,
            success: false,
            errorMessage: outcome?.errorMessage || "Unknown ACME renewal error"
          });
          failed += 1;
          logger.warn?.(`ACME certificate renewal failed for ${cert.hostname}`, {
            cert_id: cert.id,
            error: outcome?.errorMessage
          });
        }
      }
    } catch (err) {
      logger.error?.("ACME renewal worker error", { error: err.message });
    } finally {
      running = false;
    }

    return { processed, renewed, failed };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void checkAndRenew(); }, checkIntervalMs);
    if (timer && timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { checkAndRenew, start, stop };
}
