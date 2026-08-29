# D-007 retention dry-run

**Status:** approved for synthetic, non-destructive dry runs only. This runbook
does not authorize a purge, export delivery, provider contact, pilot launch, or
production operation.

## Purpose

Produce a repeatable, aggregate-only evidence record for the approved D-007
365-day retention rule. The implementation evaluates supplied, non-identifying
candidates and returns `MANUAL_REVIEW_REQUIRED` in every case.

## Preconditions

- A named Privacy owner has approved the specific synthetic source and as-of
  time for the drill.
- Inputs contain no names, contact details, tenant IDs, case IDs, user IDs, or
  free-text case content.
- The candidate activity timestamp is the later of case closure and participant
  activity, as defined by the drill's approved source mapping.
- Exclusions have been resolved from an approved source. They include open
  cases, legal holds, unresolved safety or security incidents, active provider
  or payment disputes, incomplete export or deletion requests, and statutory
  retention obligations.

## Procedure

1. Set and record an explicit UTC `asOf` time.
2. Build non-identifying candidates containing only the two timestamps and the
   applicable exclusion codes.
3. Call `summarizeRetentionDryRun(candidates, asOf)`.
4. Retain only the aggregate summary and source-mapping evidence. Do not retain
   candidate-level output in the evidence packet.
5. Route every indicated candidate through manual Privacy review. An eligible
   result means eligible **for review**, not for deletion.
6. Record any provider-side deletion status only through the D-007 operation
   record after an independently authorized deletion operation. The outcome
   recording function does not contact providers.

## Evidence record

Record the following, using observed values only:

- drill date and UTC `asOf` time
- approved source-mapping revision
- `candidateCount`
- `eligibleForManualReviewCount`
- `excludedOrNotYetEligibleCount`
- `reasonCounts`
- the named Privacy reviewer and their disposition
- any exception or unresolved mapping gap

Do not mark the Privacy gate ready from this dry run. The outstanding export
release, named privacy ownership, destructive purge authorization, representative
database exercise, and required human reviews remain separate gates.
