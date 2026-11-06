-- 0018_current_case_index.sql — a RESOLVED case no longer blocks the Veteran's next case
--
-- Implements the v1 decision of 2026-11-05: a Veteran's new request after their Support
-- Case is RESOLVED opens a new Support Case, so it reaches the open list. Until now the
-- "one active case per Veteran" index counted RESOLVED as active, so a new case could not
-- exist beside a resolved one and the new request joined the resolved case, where nobody
-- could accept it.
--
-- A Veteran may now have one RESOLVED case and one new current case together. Two current
-- cases (every status except RESOLVED and CLOSED) are still refused. This departs from the
-- SUAS-specs CASES.md section 3 MVP default of one non-closed case, and is recorded as a
-- spec proposal. Existing data cannot violate the narrower rule: it only has fewer rows.

DROP INDEX support_cases_one_active_per_veteran;

CREATE UNIQUE INDEX support_cases_one_active_per_veteran
    ON support_cases (tenant_id, veteran_user_id)
    WHERE status NOT IN ('RESOLVED', 'CLOSED');
