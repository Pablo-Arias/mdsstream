-- One row per device per set per day: a listen counts once a day per device.
CREATE TABLE IF NOT EXISTS listens (
  set_id TEXT NOT NULL,
  device TEXT NOT NULL,
  day    TEXT NOT NULL,
  PRIMARY KEY (set_id, device, day)
);

-- One rating per device per set; rating again replaces it.
CREATE TABLE IF NOT EXISTS ratings (
  set_id  TEXT NOT NULL,
  device  TEXT NOT NULL,
  stars   INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated TEXT NOT NULL,
  PRIMARY KEY (set_id, device)
);

-- Phones that asked to be notified of new sets.
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint    TEXT PRIMARY KEY,
  created     TEXT NOT NULL,
  last_push   TEXT,  -- when we last sent it a notification
  last_status TEXT   -- what the push service answered (201 = accepted)
);

-- Sets we've already sent a notification for.
CREATE TABLE IF NOT EXISTS notified (
  set_id TEXT PRIMARY KEY,
  at     TEXT NOT NULL
);

-- "Good part" marks, in 30-second windows: one per device per window.
CREATE TABLE IF NOT EXISTS moments (
  set_id  TEXT NOT NULL,
  device  TEXT NOT NULL,
  bucket  INTEGER NOT NULL,
  created TEXT NOT NULL,
  PRIMARY KEY (set_id, device, bucket)
);

-- Files in the R2 bucket: stable id and original date per file name (kept across renames).
CREATE TABLE IF NOT EXISTS files (
  key  TEXT PRIMARY KEY,
  id   TEXT NOT NULL,
  date TEXT NOT NULL,
  etag TEXT
);
