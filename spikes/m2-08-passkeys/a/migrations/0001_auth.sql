-- Spike A: the whole auth schema we would own.
CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                 -- credential ID, base64url
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);
CREATE TABLE webauthn_challenges (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  challenge TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,            -- sha256(opaque 256-bit ID)
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
