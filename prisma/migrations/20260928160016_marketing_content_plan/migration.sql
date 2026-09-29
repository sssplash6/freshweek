-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MARKETING';

-- CreateTable
CREATE TABLE "ContentShoot" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shootAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL,
    "assigneeId" TEXT,
    "note" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "finishedUrl" TEXT,
    "rawUrl" TEXT,
    "reportedAt" TIMESTAMP(3),
    "reportedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentShoot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPost" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publishAt" TIMESTAMP(3) NOT NULL,
    "shootId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingTask" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "dueOn" TIMESTAMP(3),
    "assigneeId" TEXT NOT NULL,
    "percent" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentShoot_shootAt_idx" ON "ContentShoot"("shootAt");

-- CreateIndex
CREATE INDEX "ContentShoot_assigneeId_idx" ON "ContentShoot"("assigneeId");

-- CreateIndex
CREATE INDEX "ContentPost_publishAt_idx" ON "ContentPost"("publishAt");

-- CreateIndex
CREATE INDEX "MarketingTask_assigneeId_idx" ON "MarketingTask"("assigneeId");

-- CreateIndex
CREATE INDEX "MarketingTask_dueOn_idx" ON "MarketingTask"("dueOn");

-- AddForeignKey
ALTER TABLE "ContentShoot" ADD CONSTRAINT "ContentShoot_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentShoot" ADD CONSTRAINT "ContentShoot_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentShoot" ADD CONSTRAINT "ContentShoot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_shootId_fkey" FOREIGN KEY ("shootId") REFERENCES "ContentShoot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingTask" ADD CONSTRAINT "MarketingTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingTask" ADD CONSTRAINT "MarketingTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
