CREATE TABLE IF NOT EXISTS meeting (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255),
    audio_path VARCHAR(1024),
    created_at TIMESTAMP
);
