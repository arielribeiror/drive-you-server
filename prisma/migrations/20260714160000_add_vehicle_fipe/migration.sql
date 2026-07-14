CREATE TYPE "FipeVehicleType" AS ENUM ('cars', 'motorcycles', 'trucks');

CREATE TYPE "FipeLinkSource" AS ENUM ('automatic', 'confirmed', 'manual');

ALTER TABLE "Vehicle"
ADD COLUMN "fipeVehicleType" "FipeVehicleType",
ADD COLUMN "fipeBrandCode" TEXT,
ADD COLUMN "fipeModelCode" TEXT,
ADD COLUMN "fipeYearId" TEXT,
ADD COLUMN "fipeCode" TEXT,
ADD COLUMN "fipeDisplayName" TEXT,
ADD COLUMN "fipeLinkSource" "FipeLinkSource",
ADD COLUMN "fipeLinkedAt" TIMESTAMP(3);

CREATE TABLE "VehicleFipePrice" (
  "id" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "fipeCode" TEXT NOT NULL,
  "yearId" TEXT NOT NULL,
  "referenceCode" TEXT NOT NULL,
  "referenceMonth" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VehicleFipePrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VehicleFipePrice_vehicleId_fipeCode_yearId_referenceCode_key"
ON "VehicleFipePrice"("vehicleId", "fipeCode", "yearId", "referenceCode");

CREATE INDEX "VehicleFipePrice_vehicleId_fetchedAt_idx"
ON "VehicleFipePrice"("vehicleId", "fetchedAt");

CREATE INDEX "VehicleFipePrice_fipeCode_yearId_idx"
ON "VehicleFipePrice"("fipeCode", "yearId");

CREATE INDEX "Vehicle_fipeCode_idx"
ON "Vehicle"("fipeCode");

ALTER TABLE "VehicleFipePrice"
ADD CONSTRAINT "VehicleFipePrice_vehicleId_fkey"
FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
