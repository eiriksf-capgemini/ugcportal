-- AlterTable
ALTER TABLE "Media" ADD COLUMN "previewKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Media_previewKey_key" ON "Media"("previewKey");
