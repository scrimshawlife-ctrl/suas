-- 0021_resource_contacts_area.sql — contact list and area line (Round 8 R8.8, R8.9, D-059)
--
-- Implements suas-specs V1_MVP_PROPOSAL.md R8.8 (up to three contact methods per resource,
-- each with a kind) and R8.9 (an optional short `area` line). Both are proposals, not
-- released.
--
-- contacts: one bounded jsonb array of {kind, value} on the resource and the draft. The
-- single contact_method / contact_method_kind columns stay and mirror the first entry, so
-- existing readers keep working. Entry shape is checked in the application; the database
-- bounds the array.
--
-- area: catalog text only, at most 80 characters.
--
-- verified_at (R8.9) is last_verified_at under a client-facing name and adds no column.

ALTER TABLE resources
    ADD COLUMN contacts jsonb NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT resources_contacts_check
        CHECK (jsonb_typeof(contacts) = 'array' AND jsonb_array_length(contacts) <= 3),
    ADD COLUMN area text
        CONSTRAINT resources_area_check CHECK (char_length(area) <= 80);

ALTER TABLE resource_drafts
    ADD COLUMN contacts jsonb NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT resource_drafts_contacts_check
        CHECK (jsonb_typeof(contacts) = 'array' AND jsonb_array_length(contacts) <= 3),
    ADD COLUMN area text
        CONSTRAINT resource_drafts_area_check CHECK (char_length(area) <= 80);

-- A row with one contact keeps it as the first list entry; no kind reads as FREEFORM.
UPDATE resources
   SET contacts = jsonb_build_array(
         jsonb_build_object('kind', COALESCE(contact_method_kind, 'FREEFORM'), 'value', contact_method))
 WHERE contact_method IS NOT NULL;

UPDATE resource_drafts
   SET contacts = jsonb_build_array(
         jsonb_build_object('kind', COALESCE(contact_method_kind, 'FREEFORM'), 'value', contact_method))
 WHERE contact_method IS NOT NULL;
