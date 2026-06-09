ALTER TABLE "MagicLinkToken"
  ADD COLUMN "codeHash" TEXT;

CREATE INDEX "MagicLinkToken_emailNormalized_codeHash_idx" ON "MagicLinkToken"("emailNormalized", "codeHash");
