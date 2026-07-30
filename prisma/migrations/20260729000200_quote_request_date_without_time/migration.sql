ALTER TABLE "quote_requests"
  ADD COLUMN "departure_date" DATE,
  ADD COLUMN "return_date" DATE;

UPDATE "quote_requests"
SET
  "departure_date" = "departure_at"::date,
  "return_date" = "return_at"::date
WHERE "departure_at" IS NOT NULL
   OR "return_at" IS NOT NULL;
