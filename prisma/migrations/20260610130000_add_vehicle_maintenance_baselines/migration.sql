-- CreateEnum
CREATE TYPE "VehicleMaintenanceItem" AS ENUM (
    'engine_oil',
    'tires',
    'suspension',
    'brake_fluid',
    'brake_disc',
    'brake_pads',
    'tire_pressure'
);

-- CreateEnum
CREATE TYPE "VehicleUsageProfile" AS ENUM ('severe', 'light');

-- CreateTable
CREATE TABLE "VehicleMaintenanceBaseline" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "item" "VehicleMaintenanceItem" NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL,
    "odometerKm" INTEGER NOT NULL,
    "usageProfile" "VehicleUsageProfile",
    "intervalKm" INTEGER NOT NULL,
    "intervalMonths" INTEGER,
    "intervalDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleMaintenanceBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleMaintenanceBaseline_userId_vehicleId_item_key" ON "VehicleMaintenanceBaseline"("userId", "vehicleId", "item");

-- CreateIndex
CREATE INDEX "VehicleMaintenanceBaseline_vehicleId_idx" ON "VehicleMaintenanceBaseline"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleMaintenanceBaseline_userId_idx" ON "VehicleMaintenanceBaseline"("userId");

-- CreateIndex
CREATE INDEX "VehicleMaintenanceBaseline_item_idx" ON "VehicleMaintenanceBaseline"("item");

-- AddForeignKey
ALTER TABLE "VehicleMaintenanceBaseline" ADD CONSTRAINT "VehicleMaintenanceBaseline_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMaintenanceBaseline" ADD CONSTRAINT "VehicleMaintenanceBaseline_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
