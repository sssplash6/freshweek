-- A private notepad per person (lib/notepad.ts decides who sees one).
CREATE TABLE IF NOT EXISTS "Notepad" (
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notepad_pkey" PRIMARY KEY ("userId")
);

DO $$ BEGIN
  ALTER TABLE "Notepad" ADD CONSTRAINT "Notepad_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
