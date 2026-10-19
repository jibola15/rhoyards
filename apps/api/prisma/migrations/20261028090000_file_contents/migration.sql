-- File bytes stored in the database (STORAGE_DRIVER=database), for hosts without a lasting shared disk.
CREATE TABLE "file_contents" (
    "key" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_contents_pkey" PRIMARY KEY ("key")
);

-- Written once, never changed (like the files that point at them).
CREATE OR REPLACE FUNCTION "file_contents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Stored file % cannot be changed', OLD."key";
END;
$$;
CREATE TRIGGER "file_contents_guard_trg" BEFORE UPDATE ON "file_contents" FOR EACH ROW EXECUTE FUNCTION "file_contents_guard"();
