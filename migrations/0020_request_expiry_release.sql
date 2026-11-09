-- 0020_request_expiry_release.sql — request expiry and helper release (Round 8 R8.4, R8.5)
--
-- Implements suas-specs V1_MVP_PROPOSAL.md R8.4 (an unaccepted request expires 72 hours
-- after submit) and R8.5 (the accepter may release a request, which returns to SUBMITTED
-- and may be accepted again, by the same helper too). Both are proposals, not released.
--
-- TTL: read by the expiry job like widening_delay_minutes (0013); the job fails closed
-- when the row is missing or not a whole number of hours of at least one.
--
-- service_requests.accepted_at: when the request was last accepted. It replaces reading
-- chat_threads.created_at, which stops meaning "the accept" once a release closes a thread
-- and a re-accept opens a new one. Backfilled from the thread made in the accept transaction.
--
-- chat_threads: a request may now have many threads over time, but only one live one. A
-- release sets released_at; the next accept inserts a new row. The partial unique index
-- keeps "one live thread per request" and is the ON CONFLICT target of the accept.

INSERT INTO app_settings (setting_key, value) VALUES ('request_expiry_hours', '72'::jsonb);

ALTER TABLE service_requests ADD COLUMN accepted_at timestamptz;

UPDATE service_requests r
   SET accepted_at = t.created_at
  FROM chat_threads t
 WHERE t.service_request_id = r.service_request_id AND t.tenant_id = r.tenant_id;

ALTER TABLE chat_threads
    DROP CONSTRAINT chat_threads_service_request_id_key,
    ADD COLUMN released_at timestamptz;

CREATE UNIQUE INDEX chat_threads_one_live_per_request_idx
    ON chat_threads (service_request_id)
    WHERE released_at IS NULL;

-- Expiry pickup. The widening index above skips requests that already widened, and the
-- expiry job must find those too.
CREATE INDEX service_requests_expiry_idx
    ON service_requests (submitted_at)
    WHERE accepted_by_user_id IS NULL AND status IN ('SUBMITTED', 'TRIAGED', 'MATCHING');
