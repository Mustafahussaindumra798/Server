# Domain management API

All routes require a valid Cloudexify user access token and an active tenant membership. Domain creation, challenge renewal and verification are restricted to tenant owners and admins. Viewers and operators may list/read domain status but cannot mutate claims.

## Create a domain claim

`POST /api/v1/tenants/{tenant_id}/domains`

JSON body:

```json
{ "hostname": "app.example.com" }
```

The API canonicalizes the hostname to lowercase ASCII/IDNA, rejects schemes, ports, paths, wildcards, IP literals and localhost, then atomically creates a pending claim and 30-minute DNS challenge.

The response includes a TXT instruction:

- Record type: `TXT`
- Record name: `_cloudexify-verify.app.example.com`
- Record value: `cloudexify-verification=<random-token>`

The random token is 256 bits of entropy. Only its SHA-256 hash is stored. The plaintext value is returned once at challenge creation; it cannot be retrieved later. Save it before leaving the response.

## List and inspect claims

- `GET /api/v1/tenants/{tenant_id}/domains`
- `GET /api/v1/tenants/{tenant_id}/domains/{domain_id}`

The detail response includes the latest challenge record name and expiry, but never the token or token hash.

## Renew an expired challenge

`POST /api/v1/tenants/{tenant_id}/domains/{domain_id}/challenge`

A still-active challenge cannot be replaced. Once expired, the API revokes it through the database lifecycle function and creates a new 30-minute challenge. The new plaintext TXT value is returned once.

## Verify DNS ownership

`POST /api/v1/tenants/{tenant_id}/domains/{domain_id}/verify`

The API resolves TXT records for the exact challenge name and compares the token hash to the active challenge. DNS absence or mismatch returns `200` with `verified: false` and a machine-readable reason. Resolver failures return `503`. Successful verification consumes the challenge atomically and changes the claim to `verified`; replay is rejected by the database function.

## Important limits

- This API verifies DNS ownership only. It does not yet configure customer DNS, create ingress routes, provision certificates, or make a deployment publicly reachable.
- The DNS challenge expires after 30 minutes (the database enforces a maximum one-hour lifetime).
- Active hostname uniqueness is global across tenants until a claim is released through a future lifecycle API.
- The TXT value is a bearer proof of DNS control. Do not post it publicly or commit it to source control.
