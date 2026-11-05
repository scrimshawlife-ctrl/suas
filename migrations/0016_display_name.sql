-- 0016_display_name.sql — a name other people see on a request or in chat
--
-- Implements the v1 web decision of 2026-11-04: a person sets a short display name
-- ("First name and last initial, like Marcus T.") that the other participant of a
-- request sees. It is optional until the person chooses one, so existing and
-- self-signed-up users keep working. The CHECK is the same rule the API enforces:
-- trimmed, 1 to 40 characters.

ALTER TABLE users
    ADD COLUMN display_name text,
    ADD CONSTRAINT users_display_name_check
        CHECK (display_name IS NULL
               OR (display_name = btrim(display_name)
                   AND char_length(display_name) BETWEEN 1 AND 40));
