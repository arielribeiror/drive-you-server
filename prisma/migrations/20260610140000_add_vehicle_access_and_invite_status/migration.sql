-- CreateEnum
CREATE TYPE "VehicleAccessRole" AS ENUM ('owner', 'shared');

-- CreateEnum
CREATE TYPE "VehicleShareInviteStatus" AS ENUM ('pending', 'accepted', 'expired', 'revoked');

-- AlterTable
ALTER TABLE "VehicleShareInvite" ADD COLUMN "status" "VehicleShareInviteStatus" NOT NULL DEFAULT 'pending';

-- Existing accepted invites should keep their semantic status.
UPDATE "VehicleShareInvite"
SET "status" = 'accepted'
WHERE "acceptedAt" IS NOT NULL;

-- CreateTable
CREATE TABLE "VehicleAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "role" "VehicleAccessRole" NOT NULL DEFAULT 'shared',
    "inviteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleAccess_pkey" PRIMARY KEY ("id")
);

-- Backfill owner access for every existing vehicle.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO "VehicleAccess" ("id", "userId", "vehicleId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "userId", "id", 'owner'::"VehicleAccessRole", "createdAt", "updatedAt"
FROM "Vehicle" v
WHERE NOT EXISTS (
  SELECT 1
  FROM "VehicleAccess" a
  WHERE a."userId" = v."userId" AND a."vehicleId" = v."id"
);

-- Backfill shared access for invites accepted before this migration.
INSERT INTO "VehicleAccess" ("id", "userId", "vehicleId", "role", "inviteId", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  i."acceptedByUserId",
  i."vehicleId",
  'shared'::"VehicleAccessRole",
  i."id",
  COALESCE(i."acceptedAt", i."createdAt"),
  COALESCE(i."acceptedAt", i."createdAt")
FROM "VehicleShareInvite" i
WHERE i."acceptedByUserId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "VehicleAccess" a
    WHERE a."userId" = i."acceptedByUserId" AND a."vehicleId" = i."vehicleId"
  );

-- If previous test data ever created duplicate baselines for the same physical vehicle,
-- keep the most recently updated row before tightening the uniqueness rule.
WITH ranked_baselines AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "vehicleId", "item"
      ORDER BY "updatedAt" DESC, "id" DESC
    ) AS row_number
  FROM "VehicleMaintenanceBaseline"
)
DELETE FROM "VehicleMaintenanceBaseline"
WHERE "id" IN (
  SELECT "id"
  FROM ranked_baselines
  WHERE row_number > 1
);

-- DropIndex
DROP INDEX IF EXISTS "VehicleMaintenanceBaseline_userId_vehicleId_item_key";

-- CreateIndex
CREATE UNIQUE INDEX "VehicleAccess_inviteId_key" ON "VehicleAccess"("inviteId");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleAccess_userId_vehicleId_key" ON "VehicleAccess"("userId", "vehicleId");

-- CreateIndex
CREATE INDEX "VehicleAccess_vehicleId_idx" ON "VehicleAccess"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleAccess_userId_idx" ON "VehicleAccess"("userId");

-- CreateIndex
CREATE INDEX "VehicleAccess_role_idx" ON "VehicleAccess"("role");

-- CreateIndex
CREATE INDEX "VehicleShareInvite_status_idx" ON "VehicleShareInvite"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleMaintenanceBaseline_vehicleId_item_key" ON "VehicleMaintenanceBaseline"("vehicleId", "item");

-- AddForeignKey
ALTER TABLE "VehicleAccess" ADD CONSTRAINT "VehicleAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleAccess" ADD CONSTRAINT "VehicleAccess_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleAccess" ADD CONSTRAINT "VehicleAccess_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "VehicleShareInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
