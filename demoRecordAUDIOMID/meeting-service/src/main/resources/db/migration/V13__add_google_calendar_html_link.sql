ALTER TABLE google_calendar_links
    ADD COLUMN IF NOT EXISTS html_link TEXT;
