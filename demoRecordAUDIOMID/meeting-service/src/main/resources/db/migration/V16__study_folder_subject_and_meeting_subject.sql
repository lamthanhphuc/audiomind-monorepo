-- Phase 1: study folders, subjects, and optional meeting.subject_id linkage.

CREATE TABLE study_folder (
    id BIGSERIAL PRIMARY KEY,
    owner_user_id BIGINT NOT NULL,
    parent_folder_id BIGINT NULL,
    name VARCHAR(150) NOT NULL,
    color VARCHAR(20) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL,
    CONSTRAINT fk_study_folder_parent
        FOREIGN KEY (parent_folder_id)
        REFERENCES study_folder(id)
);

CREATE TABLE subject (
    id BIGSERIAL PRIMARY KEY,
    owner_user_id BIGINT NOT NULL,
    folder_id BIGINT NULL,
    name VARCHAR(200) NOT NULL,
    code VARCHAR(50) NULL,
    semester VARCHAR(100) NULL,
    description TEXT NULL,
    color VARCHAR(20) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    archived_at TIMESTAMP NULL,
    CONSTRAINT fk_subject_folder
        FOREIGN KEY (folder_id)
        REFERENCES study_folder(id)
);

ALTER TABLE meeting
    ADD COLUMN subject_id BIGINT NULL;

ALTER TABLE meeting
    ADD CONSTRAINT fk_meeting_subject
    FOREIGN KEY (subject_id)
    REFERENCES subject(id)
    ON DELETE SET NULL;

CREATE INDEX idx_study_folder_owner
    ON study_folder(owner_user_id);

CREATE INDEX idx_study_folder_parent
    ON study_folder(parent_folder_id);

CREATE INDEX idx_subject_owner
    ON subject(owner_user_id);

CREATE INDEX idx_subject_folder
    ON subject(folder_id);

CREATE INDEX idx_meeting_subject
    ON meeting(subject_id);

CREATE INDEX idx_meeting_owner_unclassified
    ON meeting(owner_user_id)
    WHERE subject_id IS NULL
      AND deleted_at IS NULL;

CREATE UNIQUE INDEX uq_study_folder_owner_parent_name_active
    ON study_folder (
        owner_user_id,
        COALESCE(parent_folder_id, -1),
        lower(btrim(name))
    )
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX uq_subject_owner_name_active
    ON subject (
        owner_user_id,
        lower(btrim(name))
    )
    WHERE archived_at IS NULL;
