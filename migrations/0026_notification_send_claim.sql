-- 0026_notification_send_claim.sql — internal claim on a Notification's next send attempt
--
-- NOTIFICATIONS.md §3, §5: one provider attempt per logical send. A runner sets the claim
-- before the provider call and the settle clears it, fenced on the token, so a second runner
-- cannot send or record SENT. Kept apart from delivery_status and last_attempt_at, which stay
-- the §3/§6 record. Internal only: never in the API. Additive and nullable.

ALTER TABLE notifications
    ADD COLUMN send_claim_token uuid,
    ADD COLUMN send_claimed_at timestamptz;
