-- Up Migration

-- Monitors: the unit of observation. Capture settings live here; the encrypted
-- credentials live in monitor_secrets so that a plain SELECT on monitors can never
-- leak a header or cookie value.
CREATE TABLE monitors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  url                  text NOT NULL,
  enabled              boolean NOT NULL DEFAULT true,
  paused               boolean NOT NULL DEFAULT false,
  schedule_kind        text NOT NULL DEFAULT 'preset'
                         CHECK (schedule_kind IN ('preset', 'cron')),
  schedule_value       text NOT NULL,
  schedule_cron        text NOT NULL,
  device_preset        text NOT NULL DEFAULT 'desktop'
                         CHECK (device_preset IN ('desktop', 'tablet', 'mobile')),
  viewport_width       integer NOT NULL DEFAULT 1280,
  viewport_height      integer NOT NULL DEFAULT 800,
  full_page            boolean NOT NULL DEFAULT true,
  wait_strategy        text NOT NULL DEFAULT 'load'
                         CHECK (wait_strategy IN ('load', 'networkidle', 'selector')),
  wait_selector        text,
  extra_delay_ms       integer NOT NULL DEFAULT 0,
  capture_selector     text,
  ignore_selectors     text[] NOT NULL DEFAULT '{}',
  user_agent           text,
  change_threshold     double precision NOT NULL DEFAULT 0.5,
  detect_text          boolean NOT NULL DEFAULT true,
  detect_html          boolean NOT NULL DEFAULT true,
  retention_days       integer,
  tags                 text[] NOT NULL DEFAULT '{}',
  consecutive_failures integer NOT NULL DEFAULT 0,
  failure_notified     boolean NOT NULL DEFAULT false,
  last_run_at          timestamptz,
  last_snapshot_at     timestamptz,
  last_change_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX monitors_enabled_idx ON monitors (enabled);
CREATE INDEX monitors_tags_idx ON monitors USING gin (tags);
CREATE INDEX monitors_last_run_idx ON monitors (last_run_at);

-- Encrypted capture credentials. header_names / cookie_names are stored in the clear so
-- the API can tell the user *which* headers are configured without decrypting anything.
CREATE TABLE monitor_secrets (
  monitor_id   uuid PRIMARY KEY REFERENCES monitors (id) ON DELETE CASCADE,
  headers_enc  text,
  cookies_enc  text,
  header_names text[] NOT NULL DEFAULT '{}',
  cookie_names text[] NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One capture of one monitor. Failed captures are stored too (status = 'failed') so the
-- UI can show the failure history; they never produce a Change.
CREATE TABLE snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id            uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  status                text NOT NULL CHECK (status IN ('success', 'failed')),
  captured_at           timestamptz NOT NULL DEFAULT now(),
  final_url             text,
  http_status           integer,
  load_duration_ms      integer,
  title                 text,
  error_message         text,
  screenshot_key        text,
  html_key              text,
  text_key              text,
  screenshot_width      integer,
  screenshot_height     integer,
  screenshot_hash       text,
  html_hash             text,
  text_hash             text,
  -- Set when this snapshot's content matched an earlier one: no new artefacts were
  -- written, the keys point at the previous snapshot's files.
  duplicate_of          uuid REFERENCES snapshots (id) ON DELETE SET NULL,
  bytes                 bigint,
  request_count         integer,
  hidden_element_count  integer,
  blocked_request_count integer NOT NULL DEFAULT 0
);

CREATE INDEX snapshots_monitor_captured_idx ON snapshots (monitor_id, captured_at DESC);
CREATE INDEX snapshots_monitor_status_idx ON snapshots (monitor_id, status);
CREATE INDEX snapshots_captured_at_idx ON snapshots (captured_at);

-- A comparison between a snapshot and the previous successful snapshot of the monitor.
CREATE TABLE changes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id         uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  from_snapshot_id   uuid REFERENCES snapshots (id) ON DELETE SET NULL,
  to_snapshot_id     uuid NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  pixel_diff_percent double precision,
  changed_pixels     bigint,
  total_pixels       bigint,
  size_changed       boolean NOT NULL DEFAULT false,
  size_from_width    integer,
  size_from_height   integer,
  size_to_width      integer,
  size_to_height     integer,
  text_added         integer,
  text_removed       integer,
  html_added         integer,
  html_removed       integer,
  significant        boolean NOT NULL DEFAULT false,
  summary            text NOT NULL DEFAULT '',
  regions            jsonb NOT NULL DEFAULT '[]'::jsonb,
  diff_image_key     text,
  -- Stored so the viewer can render without recomputing; truncated for very large diffs.
  text_diff          jsonb,
  html_diff          jsonb,
  truncated          boolean NOT NULL DEFAULT false,
  duration_ms        integer
);

-- One change per snapshot: re-running a comparison updates rather than duplicates.
CREATE UNIQUE INDEX changes_to_snapshot_uniq ON changes (to_snapshot_id);
CREATE INDEX changes_monitor_created_idx ON changes (monitor_id, created_at DESC);
CREATE INDEX changes_monitor_significant_idx ON changes (monitor_id, significant);
CREATE INDEX changes_created_at_idx ON changes (created_at);

-- Down Migration

DROP TABLE IF EXISTS changes;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS monitor_secrets;
DROP TABLE IF EXISTS monitors;
