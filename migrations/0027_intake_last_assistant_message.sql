-- 0027_intake_last_assistant_message.sql — the assistant's last reply on an open intake draft
--
-- R18.4 (contributor proposal, not released): a follow-up message is read together with the
-- question the assistant last asked, so "Tuesday" answers "When do you need it?". Model text,
-- bounded like the reply itself (1500 characters); cleared on submit. Never in an API response,
-- an event, an audit payload or a log. Additive and nullable.

ALTER TABLE service_request_drafts
    ADD COLUMN last_assistant_message text,
    ADD CONSTRAINT service_request_drafts_last_assistant_message_length
        CHECK (last_assistant_message IS NULL OR char_length(last_assistant_message) <= 1500);
