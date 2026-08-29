# Authenticated-route evidence

## Public boundary checks

`PASS` on 2026-08-29 for public STAGING checks: health response, landing/enrollment path, protected-route unauthenticated denial (401), keyboard navigation, and 320 px reflow. See `../logs-sanitized/public-e2e-result.json`.

## Privileged matrix

`BLOCKED`: no explicitly authorized operator-scoped synthetic credentials and no positively identified deployed SHA were supplied. Credential values were neither read nor inferred. The campaign did not attempt participant, operator, wrong-role, cross-tenant, expired, revoked, or invalid credential requests.

The next authorized run must derive routes from runtime code/OpenAPI and cover no credential, invalid, expired, participant, operator, wrong role, tenant A to tenant B, and revoked states. It must assert canonical denial, no tenant-existence disclosure, privileged-attempt audit events, no secret material, and no other-tenant data. Use two synthetic tenants with overlapping human-readable values and opaque tenant identities.
