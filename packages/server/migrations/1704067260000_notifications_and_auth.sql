-- Up Migration

-- Notification channels. `config` holds the non-secret view (url, recipients);
-- `config_enc` holds the full config including any signing secret, AES-256-GCM
-- encrypted with PAGEFREEZE_SECRET_KEY.
CREATE TABLE notification_channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('webhook', 'slack', 'email')),
  enabled          boolean NOT NULL DEFAULT true,
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_enc       text,
  last_notified_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_channels_enabled_idx ON notification_channels (enabled);

CREATE TABLE monitor_channels (
  monitor_id uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, channel_id)
);

CREATE INDEX monitor_channels_channel_idx ON monitor_channels (channel_id);

-- API tokens. Only the SHA-256 hash is stored; the plaintext is shown once at creation.
-- `prefix` keeps the first characters so the UI can identify a token without the secret.
CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  prefix       text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX api_tokens_prefix_idx ON api_tokens (prefix);
CREATE INDEX api_tokens_active_idx ON api_tokens (revoked_at, expires_at);

-- Cookie sessions for the web UI. The CSRF token lives in the session row and is also
-- handed to the browser as a readable cookie, so a mutating request must present both.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username     text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text
);

CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX sessions_token_idx ON sessions (token_hash);

-- Public, revocable share links for a single change. The token is unguessable
-- (256 bits) and only its hash is stored.
CREATE TABLE share_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id  uuid NOT NULL REFERENCES changes (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0
);

CREATE INDEX share_links_change_idx ON share_links (change_id);
CREATE INDEX share_links_active_idx ON share_links (revoked_at, expires_at);

-- Down Migration

DROP TABLE IF EXISTS share_links;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS monitor_channels;
DROP TABLE IF EXISTS notification_channels;
