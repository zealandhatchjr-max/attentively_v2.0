-- Ringer system of record. Kolaboreyt boards are a projection of this data.

CREATE TABLE IF NOT EXISTS users (
  id                       TEXT PRIMARY KEY,
  email                    TEXT NOT NULL UNIQUE,
  display_name             TEXT,
  api_token_hash           TEXT UNIQUE,
  assistant_number         TEXT UNIQUE,          -- never shown to the user
  voice_phone_number_id    TEXT,                 -- provider id for the assistant number
  assistant_email          TEXT UNIQUE,
  minutes_balance_seconds  INTEGER NOT NULL DEFAULT 0,
  share_data_opt_in        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendors (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  phone_e164     TEXT NOT NULL UNIQUE,
  address        TEXT,
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  category       TEXT,
  place_id       TEXT,
  hours          JSONB,          -- [{day:0-6, open:"HH:MM", close:"HH:MM"}]
  hours_source   TEXT,
  timezone       TEXT,
  dnc            BOOLEAN NOT NULL DEFAULT FALSE,
  dnc_reason     TEXT,
  dnc_source     TEXT,
  dnc_at         TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id),
  host                   TEXT NOT NULL,
  status                 TEXT NOT NULL,
  category               TEXT NOT NULL,
  request                JSONB NOT NULL,
  location               JSONB NOT NULL,
  current_plan_version   INTEGER NOT NULL DEFAULT 0,
  current_brief_version  INTEGER NOT NULL DEFAULT 0,
  next_action_at         TIMESTAMPTZ,
  locked_until           TIMESTAMPTZ,
  board_id               TEXT,
  board_url              TEXT,
  report                 JSONB,
  report_sent_at         TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  pause_reason           TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_due ON runs (status, next_action_at);

CREATE TABLE IF NOT EXISTS plan_versions (
  run_id      TEXT NOT NULL REFERENCES runs(id),
  version     INTEGER NOT NULL,
  plan        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, version)
);

CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  plan_version  INTEGER NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  method        TEXT NOT NULL,         -- 'approval_page' | 'widget'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, plan_version)
);

CREATE TABLE IF NOT EXISTS brief_versions (
  run_id      TEXT NOT NULL REFERENCES runs(id),
  version     INTEGER NOT NULL,
  brief       JSONB NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, version)
);

CREATE TABLE IF NOT EXISTS run_vendors (
  run_id        TEXT NOT NULL REFERENCES runs(id),
  vendor_id     TEXT NOT NULL REFERENCES vendors(id),
  position      INTEGER NOT NULL,
  status        TEXT NOT NULL,
  source        TEXT NOT NULL,          -- 'ringer' | 'user_added'
  recommended   BOOLEAN NOT NULL DEFAULT FALSE,
  reason        TEXT,
  selected      BOOLEAN NOT NULL DEFAULT TRUE,
  plan_version  INTEGER NOT NULL,
  round         INTEGER NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS calls (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT REFERENCES runs(id),
  vendor_id          TEXT REFERENCES vendors(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  direction          TEXT NOT NULL,        -- 'outbound' | 'inbound'
  attempt_no         INTEGER NOT NULL DEFAULT 1,
  round              INTEGER NOT NULL DEFAULT 1,
  plan_version       INTEGER,
  brief_version      INTEGER,
  provider           TEXT NOT NULL,
  provider_call_id   TEXT,
  status             TEXT NOT NULL,        -- dialing|in_progress|completed|no_answer|failed
  failure_reason     TEXT,
  caller_number      TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ,
  duration_sec       INTEGER,
  transcript         JSONB,
  summary            TEXT,
  contact_name       TEXT,
  extraction         JSONB,
  leverage           JSONB,
  negotiation_check  JSONB,
  seconds_charged    INTEGER NOT NULL DEFAULT 0,
  processed_at       TIMESTAMPTZ
);
-- Exactly-once dialing: one outbound call per (run, vendor, round, attempt).
CREATE UNIQUE INDEX IF NOT EXISTS calls_dial_once
  ON calls (run_id, vendor_id, round, attempt_no) WHERE direction = 'outbound';
CREATE UNIQUE INDEX IF NOT EXISTS calls_provider_id ON calls (provider, provider_call_id);

CREATE TABLE IF NOT EXISTS observations (
  id             TEXT PRIMARY KEY,
  run_id         TEXT REFERENCES runs(id),
  call_id        TEXT REFERENCES calls(id),
  message_id     TEXT,
  vendor_id      TEXT NOT NULL REFERENCES vendors(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  category       TEXT NOT NULL,
  offer_key      TEXT NOT NULL,         -- groups fields of one offer
  kind           TEXT NOT NULL,         -- 'exact' | 'alternative'
  phase          TEXT NOT NULL,         -- 'initial' | 'negotiated' | 'written'
  data           JSONB NOT NULL,        -- typed offer fields
  evidence       TEXT,                  -- quoted transcript/message span
  confidence     TEXT NOT NULL DEFAULT 'medium',
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until    TIMESTAMPTZ,
  shareable      BOOLEAN NOT NULL DEFAULT FALSE  -- user opted in: usable (anonymised) by other users
);
CREATE INDEX IF NOT EXISTS observations_vendor ON observations (vendor_id, category, observed_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  call_id       TEXT REFERENCES calls(id),
  vendor_id     TEXT REFERENCES vendors(id),
  question      TEXT NOT NULL,
  why_outside   TEXT,
  status        TEXT NOT NULL,          -- open | answered | skipped
  answer        TEXT,
  deadline_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel            TEXT NOT NULL,     -- sms | email
  from_address       TEXT NOT NULL,
  subject            TEXT,
  body               TEXT NOT NULL,
  matched_vendor_id  TEXT,
  matched_run_id     TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS minutes_ledger (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  delta_sec   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  call_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail of who/what approved, initiated, changed and stopped each run.
CREATE TABLE IF NOT EXISTS audit_events (
  id        BIGSERIAL PRIMARY KEY,
  run_id    TEXT,
  user_id   TEXT,
  actor     TEXT NOT NULL,     -- user | model | system | vendor
  type      TEXT NOT NULL,
  data      JSONB,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
