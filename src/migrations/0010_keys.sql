-- 0010_keys.sql — R3-1239 (BATON_SPEC §4, §10.1 R-BTN-13 as amended): machine identity by SSH
-- key. A key's credential is keyed by its fingerprint and holds only the public key; a worker
-- key registers exactly one name, unique among the keys in force. The bearer-token credentials
-- of R3-1208 stay as kind 'token' until every worker signs (R3-1239's transition).
ALTER TABLE credentials ADD COLUMN kind TEXT NOT NULL DEFAULT 'token' CHECK (kind IN ('token','worker','probe','courier','legacy'));
ALTER TABLE credentials ADD COLUMN public_key TEXT;
-- Who registered a key: 'seed' (BATON_KEYS, until R3-1240), later 'admin:<fingerprint>' or
-- 'owner:<fingerprint>' (§4). The seed revokes only its own. NULL for tokens and 'legacy'.
ALTER TABLE credentials ADD COLUMN created_by TEXT;
UPDATE credentials SET kind = 'legacy' WHERE id = 'legacy';
CREATE UNIQUE INDEX credentials_public_key ON credentials (public_key) WHERE public_key IS NOT NULL;
CREATE UNIQUE INDEX credentials_worker_name ON credentials (hostname) WHERE kind = 'worker' AND revoked_at IS NULL;

-- R-BTN-13: the replay cache for every signed request, by the signer's fingerprint — worker,
-- probe, owner or administrator key alike. Pruned after 10 minutes.
CREATE TABLE request_nonces (
  key_fingerprint TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  seen_at         INTEGER NOT NULL,
  PRIMARY KEY (key_fingerprint, nonce)
);
CREATE INDEX request_nonces_seen ON request_nonces (seen_at);
