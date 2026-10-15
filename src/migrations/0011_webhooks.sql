-- 0011_webhooks.sql — R3-1247 (BATON_SPEC §7.1 R-BTN-73, §4): GitHub App deliveries trigger
-- repository syncs. A delivery id seen is dropped (pruned after 24 hours); each repository's
-- syncs are dispatched at most once per 30 seconds, with one trailing dispatch when a window
-- in which a delivery was suppressed closes.
CREATE TABLE webhook_deliveries (
  delivery_id   TEXT PRIMARY KEY,
  received_at   INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);

CREATE TABLE webhook_dispatch (
  repository_id    TEXT PRIMARY KEY REFERENCES repositories(id),
  last_dispatch_at INTEGER NOT NULL,
  trailing_at      INTEGER                       -- the window's close, when a delivery was suppressed in it
);
