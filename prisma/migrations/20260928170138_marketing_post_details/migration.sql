-- AlterTable
ALTER TABLE "ContentPost" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "postUrl" TEXT;
