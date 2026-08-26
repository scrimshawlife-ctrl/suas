# Decision packet — D-001 / D-005 staging & hosting

**Status:** OWNER_DECISION_REQUIRED  
**Affects gates:** `OPERATIONS`, staging evidence for nearly all other gates

## Exact questions

- Where does synthetic STAGING run (cloud account, region, network boundary)?
- Which identity/secret store and egress controls apply?

## Released constraints

- PRODUCTION prohibited until SPEC-018 authorizes it.
- LOCAL/TEST/STAGING must not point at production data resources.
- Real provider effects remain false outside authorized production.

## Recommended option

A dedicated non-prod cloud project with synthetic data only, secrets in a managed store, no production DB network path. Exact vendor remains owner-controlled (do not silently default).

## Required owner action

Name hosting/account + secret store; authorize STAGING class deployment artifacts.

## Work completed independently

- Config fail-closed for PRODUCTION without authorization.
- Health/provenance surfaces; migrate CLI; OpenAPI; decision packets for D-022 and SLO/RTO.
