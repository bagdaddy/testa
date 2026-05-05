CREATE TABLE IF NOT EXISTS events_buffer AS events
ENGINE = Buffer(
    currentDatabase(),
    events,
    16,            -- num_layers
    5,             -- min_time (s)
    30,            -- max_time (s)
    10000,         -- min_rows
    100000,        -- max_rows
    10000000,      -- min_bytes
    100000000      -- max_bytes
);
