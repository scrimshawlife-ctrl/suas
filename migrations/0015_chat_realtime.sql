-- 0015_chat_realtime.sql — WebSocket connect tickets and the live-connection registry
--
-- Implements V1_PROJECT_PLAN.md §2.2 "Chat" and §4.3 F7. Messages stay in
-- chat_messages (0013) and travel over /api/v0 REST; this file only supports pushing
-- a new message to a participant's open WebSocket connections.
--
-- State lives in Postgres, not in a process, so any Lambda instance can answer
-- $connect, $disconnect and a push (AGENTS.md rule 8).

-- A one-time ticket authenticates a WebSocket connect. A browser cannot send an
-- Authorization header on a WebSocket, and the session token must not go in a URL.
-- An authenticated REST call issues a ticket (about 60 seconds, single use); the
-- $connect handler redeems it exactly once. Only the SHA-256 of the ticket is stored.
--
-- The ticket is bound to the session that issued it, and the connection inherits that
-- session. A connection outlives a request, so a push re-checks the session each time:
-- after logout, revocation, expiry or user deactivation the connection gets nothing.
CREATE TABLE chat_connect_tickets (
    ticket_hash text        PRIMARY KEY,
    tenant_id   uuid        NOT NULL,
    user_id     uuid        NOT NULL,
    session_id  uuid        NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    redeemed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id)
);

-- Expired tickets are swept by index when new ones are issued.
CREATE INDEX chat_connect_tickets_expires_idx ON chat_connect_tickets (expires_at);

-- Open connections per signed-in person. connection_id is the provider's opaque
-- identifier (API Gateway connectionId, or a random id for the local adapter).
CREATE TABLE chat_connections (
    connection_id text        PRIMARY KEY,
    tenant_id     uuid        NOT NULL,
    user_id       uuid        NOT NULL,
    session_id    uuid        NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
    connected_at  timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id)
);

CREATE INDEX chat_connections_user_idx ON chat_connections (tenant_id, user_id);
CREATE INDEX chat_connections_session_idx ON chat_connections (session_id);
