-- CreateTable
CREATE TABLE "VehicleShareInvite" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "inviterUserId" TEXT NOT NULL,
    "acceptedByUserId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleShareInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleShareInvite_tokenHash_key" ON "VehicleShareInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "VehicleShareInvite_vehicleId_idx" ON "VehicleShareInvite"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleShareInvite_inviterUserId_idx" ON "VehicleShareInvite"("inviterUserId");

-- CreateIndex
CREATE INDEX "VehicleShareInvite_acceptedByUserId_idx" ON "VehicleShareInvite"("acceptedByUserId");

-- CreateIndex
CREATE INDEX "VehicleShareInvite_expiresAt_idx" ON "VehicleShareInvite"("expiresAt");

-- AddForeignKey
ALTER TABLE "VehicleShareInvite" ADD CONSTRAINT "VehicleShareInvite_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleShareInvite" ADD CONSTRAINT "VehicleShareInvite_inviterUserId_fkey" FOREIGN KEY ("inviterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleShareInvite" ADD CONSTRAINT "VehicleShareInvite_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
