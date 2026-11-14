-- 0025_va_outage_cooldown.sql — shared VA outage cooldown (suas #287, AT09; delegated choice, proposal)
--
-- One row per deployment, kept in the database because API and worker Lambdas share no memory.
-- consecutive_failures counts transport outages (HTTP 5xx, timeout, network failure); the third
-- in a row sets opened_at: for 60 seconds no confirm request calls VA. Then one request is let
-- through as the probe (probe_started_at): a VA answer clears all three, another outage sets
-- opened_at again. A VA 400 and a per-lookup ERROR answer neither count nor close it.

CREATE TABLE va_outage_cooldown (
    cooldown_id text PRIMARY KEY CHECK (cooldown_id = 'va-confirmation'),
    consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    opened_at timestamptz,
    probe_started_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO va_outage_cooldown (cooldown_id) VALUES ('va-confirmation');
