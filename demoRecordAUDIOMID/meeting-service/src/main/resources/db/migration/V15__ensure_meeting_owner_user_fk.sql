DO $$
DECLARE
    fk_count integer;
    fk_def text;
    meeting_rel regclass;
    users_rel regclass;
    expected_def constant text := 'FOREIGN KEY (owner_user_id) REFERENCES app_users(id)';
BEGIN
    IF to_regclass('public.app_users') IS NULL THEN
        RAISE EXCEPTION 'V15 FK convergence requires public.app_users';
    END IF;

    IF to_regclass('public.meeting') IS NULL THEN
        RAISE EXCEPTION 'V15 FK convergence requires public.meeting';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'meeting'
          AND column_name = 'owner_user_id'
    ) THEN
        RAISE EXCEPTION 'V15 FK convergence requires public.meeting.owner_user_id';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.meeting m
        WHERE m.owner_user_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM public.app_users u WHERE u.id = m.owner_user_id
          )
    ) THEN
        RAISE EXCEPTION 'V15 FK convergence blocked by orphan public.meeting.owner_user_id values';
    END IF;

    SELECT COUNT(*)
    INTO fk_count
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
      AND c.conname = 'fk_meeting_owner_user';

    IF fk_count > 1 THEN
        RAISE EXCEPTION 'V15 FK convergence found % constraints named fk_meeting_owner_user in public', fk_count;
    END IF;

    IF fk_count = 1 THEN
        SELECT pg_get_constraintdef(c.oid), c.conrelid::regclass, c.confrelid::regclass
        INTO fk_def, meeting_rel, users_rel
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public'
          AND c.conname = 'fk_meeting_owner_user';

        IF meeting_rel::text <> 'meeting'
           OR users_rel::text <> 'app_users'
           OR fk_def <> expected_def THEN
            RAISE EXCEPTION 'fk_meeting_owner_user exists with incompatible definition: %', fk_def;
        END IF;

        RETURN;
    END IF;

    ALTER TABLE public.meeting
        ADD CONSTRAINT fk_meeting_owner_user
        FOREIGN KEY (owner_user_id)
        REFERENCES public.app_users(id);
END $$;
