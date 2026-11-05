-- 0013_peer_matching.sql — county adjacency, settings, drafts, chat
--
-- Implements V1_PROJECT_PLAN.md §2.1 and §4.2 (new v1 schema): same-county matching
-- with widening to bordering counties, the Intake Assistant and catalog-builder
-- drafts, and one chat thread per Service Request.
--
-- The person who accepts a request has no agreed name yet (plan §8 #19), so columns
-- say accepted_by_user_id and no role name appears here.

-- ---------------------------------------------------------------------------
-- County adjacency (plan §2.1 "Widening")
-- ---------------------------------------------------------------------------
--
-- Bordering county pairs among the seven launch counties only. Each border is stored in
-- both directions so a lookup needs no UNION. Source: the Adjacent counties data on
-- each county's Wikipedia page. A border across water counts: San Mateo and Alameda
-- meet only across San Francisco Bay and are listed (the owner's call).

CREATE TABLE county_adjacency (
    county          suas_county NOT NULL,
    adjacent_county suas_county NOT NULL,

    PRIMARY KEY (county, adjacent_county),
    CHECK (county <> adjacent_county)
);

INSERT INTO county_adjacency (county, adjacent_county)
SELECT a, b FROM (VALUES
    ('SANTA_CLARA'::suas_county, 'ALAMEDA'::suas_county),
    ('SANTA_CLARA', 'SAN_MATEO'),
    ('SANTA_CLARA', 'SANTA_CRUZ'),
    ('SANTA_CLARA', 'SAN_BENITO'),
    ('SANTA_CLARA', 'MERCED'),
    ('SANTA_CLARA', 'STANISLAUS'),
    ('SAN_MATEO', 'SANTA_CRUZ'),
    ('ALAMEDA', 'STANISLAUS'),
    ('SAN_MATEO', 'ALAMEDA'),
    ('SANTA_CRUZ', 'SAN_BENITO'),
    ('SAN_BENITO', 'MERCED'),
    ('MERCED', 'STANISLAUS')
) AS pairs (a, b)
UNION ALL
SELECT b, a FROM (VALUES
    ('SANTA_CLARA'::suas_county, 'ALAMEDA'::suas_county),
    ('SANTA_CLARA', 'SAN_MATEO'),
    ('SANTA_CLARA', 'SANTA_CRUZ'),
    ('SANTA_CLARA', 'SAN_BENITO'),
    ('SANTA_CLARA', 'MERCED'),
    ('SANTA_CLARA', 'STANISLAUS'),
    ('SAN_MATEO', 'SANTA_CRUZ'),
    ('ALAMEDA', 'STANISLAUS'),
    ('SAN_MATEO', 'ALAMEDA'),
    ('SANTA_CRUZ', 'SAN_BENITO'),
    ('SAN_BENITO', 'MERCED'),
    ('MERCED', 'STANISLAUS')
) AS pairs (a, b);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
--
-- Small named values an administrator may change without a deploy. The widening
-- delay is read by the widening job (plan §2.1 "Stored as a setting").

CREATE TABLE app_settings (
    setting_key text        PRIMARY KEY,
    value       jsonb       NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Who last changed it. No foreign key: the seeded row must survive test resets.
    updated_by  uuid
);

INSERT INTO app_settings (setting_key, value) VALUES ('widening_delay_minutes', '30'::jsonb);

-- ---------------------------------------------------------------------------
-- Service Request Drafts (plan §2.1 "Intake Assistant")
-- ---------------------------------------------------------------------------
--
-- The Intake Assistant produces a draft; the requester reviews, edits and submits
-- it. Submitting creates the Service Request and links it here. A plain request
-- form needs no draft.

CREATE TYPE suas_service_request_draft_status AS ENUM ('DRAFT', 'SUBMITTED', 'DISCARDED');

CREATE TABLE service_request_drafts (
    draft_id           uuid                              PRIMARY KEY,
    tenant_id          uuid                              NOT NULL,
    -- The requester who owns the draft.
    user_id            uuid                              NOT NULL,
    status             suas_service_request_draft_status NOT NULL DEFAULT 'DRAFT',
    -- Draft fields the model proposed and the requester may edit. Null until set.
    category           suas_service_category,
    details            jsonb                             NOT NULL DEFAULT '{}'::jsonb,
    -- What the requester typed. Protection is RDS storage encryption at rest (KMS on
    -- the instance); there is no app-level encryption. Sensitive free text: it must
    -- never be written to application logs (plan §2.1 "Intake text"; PRIVACY.md §3).
    intake_text        text                              NOT NULL,
    -- Set when the draft is submitted.
    service_request_id uuid,
    created_at         timestamptz                       NOT NULL DEFAULT now(),
    updated_at         timestamptz                       NOT NULL DEFAULT now(),
    submitted_at       timestamptz,

    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    FOREIGN KEY (service_request_id, tenant_id)
        REFERENCES service_requests (service_request_id, tenant_id),
    CHECK (length(intake_text) > 0),
    -- A draft is linked to its Service Request exactly when it was submitted.
    CHECK ((status = 'SUBMITTED') = (service_request_id IS NOT NULL))
);

-- One draft becomes at most one Service Request.
CREATE UNIQUE INDEX service_request_drafts_request_key
    ON service_request_drafts (service_request_id)
    WHERE service_request_id IS NOT NULL;

CREATE INDEX service_request_drafts_user_idx
    ON service_request_drafts (tenant_id, user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Resource Drafts (plan §2.1 "Catalog builder")
-- ---------------------------------------------------------------------------
--
-- Catalog-builder output. Only a SUAS Administrator's publish makes a Resource, and
-- that publish is the verification act: the model never sets last_verified_at, so
-- this table has no verification columns.

CREATE TYPE suas_resource_draft_status AS ENUM ('DRAFT', 'PUBLISHED', 'REJECTED');

CREATE TABLE resource_drafts (
    resource_draft_id   uuid                       PRIMARY KEY,
    tenant_id           uuid                       NOT NULL,
    status              suas_resource_draft_status NOT NULL DEFAULT 'DRAFT',
    -- Where the fields were extracted from. Kept so a reviewer can check them.
    source_url          text                       NOT NULL,
    -- Proposed Resource fields, mirroring `resources`.
    service_name        text                       NOT NULL,
    category            suas_service_category      NOT NULL,
    eligibility         text,
    counties            text[]                     NOT NULL DEFAULT '{}',
    hours               text,
    contact_method      text,
    contact_method_kind text
        CONSTRAINT resource_drafts_contact_method_kind_check
        CHECK (contact_method_kind IN ('PHONE', 'EMAIL', 'URL', 'FREEFORM')),
    referral_method     text,
    cost                text,
    capacity            text,
    -- Set when an Administrator publishes or rejects the draft.
    published_resource_id uuid,
    reviewed_by         uuid                       REFERENCES users (user_id),
    reviewed_at         timestamptz,
    created_at          timestamptz                NOT NULL DEFAULT now(),
    updated_at          timestamptz                NOT NULL DEFAULT now(),

    FOREIGN KEY (published_resource_id, tenant_id)
        REFERENCES resources (resource_id, tenant_id),
    CHECK ((status = 'PUBLISHED') = (published_resource_id IS NOT NULL)),
    CHECK (status = 'DRAFT' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE UNIQUE INDEX resource_drafts_published_key
    ON resource_drafts (published_resource_id)
    WHERE published_resource_id IS NOT NULL;

CREATE INDEX resource_drafts_review_idx
    ON resource_drafts (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Chat (plan §2.1 "Peer flow")
-- ---------------------------------------------------------------------------
--
-- One thread per Service Request, only between the requester and the person who
-- accepted. Text only: images, retention, read receipts and typing indicators are
-- undecided (plan §8 #7) and have no columns.

CREATE TABLE chat_threads (
    chat_thread_id      uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    service_request_id  uuid        NOT NULL,
    requester_user_id   uuid        NOT NULL,
    accepted_by_user_id uuid        NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (service_request_id, tenant_id)
        REFERENCES service_requests (service_request_id, tenant_id),
    FOREIGN KEY (requester_user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    FOREIGN KEY (accepted_by_user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    UNIQUE (service_request_id),
    UNIQUE (chat_thread_id, tenant_id),
    -- Nobody chats with themselves.
    CHECK (requester_user_id <> accepted_by_user_id)
);

CREATE INDEX chat_threads_requester_idx ON chat_threads (tenant_id, requester_user_id);
CREATE INDEX chat_threads_accepted_by_idx ON chat_threads (tenant_id, accepted_by_user_id);

CREATE TABLE chat_messages (
    chat_message_id uuid        PRIMARY KEY,
    tenant_id       uuid        NOT NULL,
    chat_thread_id  uuid        NOT NULL,
    sender_user_id  uuid        NOT NULL,
    -- Sensitive free text: never written to application logs (PRIVACY.md §3).
    body            text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (chat_thread_id, tenant_id) REFERENCES chat_threads (chat_thread_id, tenant_id),
    FOREIGN KEY (sender_user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    CHECK (length(body) > 0)
);

-- Thread history in order, with a stable tiebreak for equal timestamps.
CREATE INDEX chat_messages_thread_idx
    ON chat_messages (chat_thread_id, created_at, chat_message_id);
