CREATE TABLE IF NOT EXISTS radar_frames (
  valid_time TEXT PRIMARY KEY,
  base_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting',
  tile_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  event_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS radar_frames_valid_time_idx
  ON radar_frames(valid_time DESC);

CREATE INDEX IF NOT EXISTS radar_frames_event_id_idx
  ON radar_frames(event_id);

CREATE TABLE IF NOT EXISTS radar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS radar_events_created_at_idx
  ON radar_events(created_at DESC);

CREATE TABLE IF NOT EXISTS radar_collection_progress (
  valid_time TEXT PRIMARY KEY,
  next_tile INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT
);

CREATE TABLE IF NOT EXISTS radar_frame_manifests (
  valid_time TEXT PRIMARY KEY,
  zoom INTEGER NOT NULL,
  tiles_json TEXT NOT NULL
);

