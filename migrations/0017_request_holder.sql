-- 0017_request_holder.sql — a helper holds one Service Request, not the Veteran's whole case
--
-- Implements the v1 decision of 2026-11-05: accepting is per request. Until now the
-- accept wrote a case_assignments row, so the helper held the Veteran's whole Support
-- Case and every later request from that Veteran joined the held case, out of reach of
-- anyone else. The holder is now a column on the request itself.
--
-- The column is named accepted_by_user_id like chat_threads.accepted_by_user_id
-- (migration 0013): the person who accepts has no agreed role name (plan §8 #19). It is
-- NULL until someone accepts, and the accept sets it once. case_assignments is no longer
-- read or written by the application; the table stays as history and is not dropped here.

ALTER TABLE service_requests
    ADD COLUMN accepted_by_user_id uuid,
    ADD CONSTRAINT service_requests_accepted_by_fk
        FOREIGN KEY (accepted_by_user_id, tenant_id) REFERENCES users (user_id, tenant_id);

-- "My requests" and the holder check on a case's requests (case-level actions).
CREATE INDEX service_requests_accepted_by_idx
    ON service_requests (tenant_id, accepted_by_user_id)
    WHERE accepted_by_user_id IS NOT NULL;

-- Backfill the requests that were already accepted. A chat thread exists exactly when a
-- request was accepted (it is created in the accept transaction), and it records who
-- accepted, so it is the precise source. Requests that predate chat but moved past
-- matching under a held case take that case's active assignment, which is who ran them.
-- A request still waiting (SUBMITTED, TRIAGED, MATCHING), or one that ended without being
-- accepted, stays NULL even when its case was held, so it is open to other helpers.
UPDATE service_requests r
   SET accepted_by_user_id = COALESCE(t.accepted_by_user_id, a.accepted_by_user_id)
  FROM service_requests r2
  LEFT JOIN chat_threads t
         ON t.service_request_id = r2.service_request_id AND t.tenant_id = r2.tenant_id
  LEFT JOIN case_assignments a
         ON a.case_id = r2.case_id AND a.tenant_id = r2.tenant_id AND a.status = 'ACTIVE'
 WHERE r.service_request_id = r2.service_request_id
   AND (t.chat_thread_id IS NOT NULL
        OR (a.case_assignment_id IS NOT NULL
            AND r2.status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'FULFILLED',
                              'CONFIRMED', 'CLOSED')));
