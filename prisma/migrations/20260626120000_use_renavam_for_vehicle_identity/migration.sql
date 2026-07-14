DROP INDEX IF EXISTS "Vehicle_userId_plate_key";

CREATE UNIQUE INDEX "Vehicle_userId_renavam_key" ON "Vehicle"("userId", "renavam");

CREATE INDEX "Vehicle_renavam_idx" ON "Vehicle"("renavam");
