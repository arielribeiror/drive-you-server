-- CreateEnum
CREATE TYPE "VehicleMaintenanceEventSource" AS ENUM ('onboarding', 'manual', 'baseline_update');

-- CreateEnum
CREATE TYPE "NotificationPreferenceType" AS ENUM ('maintenance_due', 'preventive_maintenance', 'oil_change_logged', 'driving_tip', 'trip_confirmation');

-- AlterTable
ALTER TABLE "Vehicle"
ADD COLUMN "documentConfirmedAt" TIMESTAMP(3),
ADD COLUMN "documentConfirmedByUserId" TEXT;

-- Backfill existing document-based vehicles as user-confirmed ownership records.
UPDATE "Vehicle"
SET
  "documentConfirmedAt" = COALESCE("updatedAt", "createdAt"),
  "documentConfirmedByUserId" = "userId"
WHERE "documentHash" IS NOT NULL
  AND "documentConfirmedAt" IS NULL;

-- CreateTable
CREATE TABLE "VehicleMaintenanceEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "item" "VehicleMaintenanceItem" NOT NULL,
    "source" "VehicleMaintenanceEventSource" NOT NULL DEFAULT 'manual',
    "performedAt" TIMESTAMP(3) NOT NULL,
    "odometerKm" INTEGER NOT NULL,
    "costCents" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleMaintenanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationPreferenceType" NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- Backfill baseline history as historical events.
INSERT INTO "VehicleMaintenanceEvent" (
  "id",
  "userId",
  "vehicleId",
  "item",
  "source",
  "performedAt",
  "odometerKm",
  "createdAt",
  "updatedAt"
)
SELECT
  CONCAT('c', md5(CONCAT("id", ':baseline_event'))),
  "userId",
  "vehicleId",
  "item",
  'baseline_update'::"VehicleMaintenanceEventSource",
  "performedAt",
  "odometerKm",
  "createdAt",
  "updatedAt"
FROM "VehicleMaintenanceBaseline";

-- CreateIndex
CREATE INDEX "VehicleMaintenanceEvent_vehicleId_performedAt_idx" ON "VehicleMaintenanceEvent"("vehicleId", "performedAt");

-- CreateIndex
CREATE INDEX "VehicleMaintenanceEvent_userId_performedAt_idx" ON "VehicleMaintenanceEvent"("userId", "performedAt");

-- CreateIndex
CREATE INDEX "VehicleMaintenanceEvent_item_idx" ON "VehicleMaintenanceEvent"("item");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_type_key" ON "NotificationPreference"("userId", "type");

-- CreateIndex
CREATE INDEX "NotificationPreference_userId_idx" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "NotificationPreference_type_idx" ON "NotificationPreference"("type");

-- Remove legacy official-review status. Ownership is now represented by user confirmation.
ALTER TABLE "Vehicle" DROP COLUMN "verificationStatus";
DROP TYPE "VehicleVerificationStatus";

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_documentConfirmedByUserId_fkey" FOREIGN KEY ("documentConfirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMaintenanceEvent" ADD CONSTRAINT "VehicleMaintenanceEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMaintenanceEvent" ADD CONSTRAINT "VehicleMaintenanceEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
