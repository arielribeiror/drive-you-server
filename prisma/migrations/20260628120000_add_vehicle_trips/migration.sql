-- CreateEnum
CREATE TYPE "VehicleTripDetectionSource" AS ENUM ('gps', 'motion_activity', 'mixed');

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "currentOdometerIsEstimated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "VehicleTrip" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "clientTripId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "averageSpeedKmh" INTEGER,
    "maxSpeedKmh" INTEGER,
    "startLatitude" DOUBLE PRECISION NOT NULL,
    "startLongitude" DOUBLE PRECISION NOT NULL,
    "endLatitude" DOUBLE PRECISION NOT NULL,
    "endLongitude" DOUBLE PRECISION NOT NULL,
    "routePolyline" TEXT,
    "routeSampleCount" INTEGER NOT NULL DEFAULT 0,
    "detectionSource" "VehicleTripDetectionSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleTrip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleTrip_driverUserId_clientTripId_key" ON "VehicleTrip"("driverUserId", "clientTripId");

-- CreateIndex
CREATE INDEX "VehicleTrip_vehicleId_startedAt_idx" ON "VehicleTrip"("vehicleId", "startedAt");

-- CreateIndex
CREATE INDEX "VehicleTrip_driverUserId_startedAt_idx" ON "VehicleTrip"("driverUserId", "startedAt");

-- AddForeignKey
ALTER TABLE "VehicleTrip" ADD CONSTRAINT "VehicleTrip_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTrip" ADD CONSTRAINT "VehicleTrip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
