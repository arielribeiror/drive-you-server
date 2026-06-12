CREATE TYPE "VehicleVerificationStatus" AS ENUM ('pending_review', 'verified', 'rejected');

CREATE TYPE "VehicleVerificationSource" AS ENUM ('licensing_pdf');

CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "renavam" TEXT,
    "brandModel" TEXT,
    "manufactureYear" INTEGER,
    "modelYear" INTEGER,
    "ownerName" TEXT,
    "ownerDocumentMasked" TEXT,
    "verificationStatus" "VehicleVerificationStatus" NOT NULL DEFAULT 'pending_review',
    "verificationSource" "VehicleVerificationSource" NOT NULL DEFAULT 'licensing_pdf',
    "documentHash" TEXT,
    "documentFileName" TEXT,
    "documentMimeType" TEXT,
    "documentSizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Vehicle_userId_plate_key" ON "Vehicle"("userId", "plate");

CREATE INDEX "Vehicle_plate_idx" ON "Vehicle"("plate");

CREATE INDEX "Vehicle_userId_idx" ON "Vehicle"("userId");

ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
