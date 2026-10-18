-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "watchId" TEXT;

-- CreateTable
CREATE TABLE "watches" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "watchedBotId" TEXT,
    "command" TEXT,
    "intervalSeconds" INTEGER,
    "nextCheckAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "watches_watchedBotId_active_idx" ON "watches"("watchedBotId", "active");

-- CreateIndex
CREATE INDEX "watches_active_nextCheckAt_idx" ON "watches"("active", "nextCheckAt");

-- CreateIndex
CREATE INDEX "watches_spaceId_botId_idx" ON "watches"("spaceId", "botId");

-- CreateIndex
CREATE INDEX "runs_watchId_status_idx" ON "runs"("watchId", "status");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "watches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watches" ADD CONSTRAINT "watches_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watches" ADD CONSTRAINT "watches_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watches" ADD CONSTRAINT "watches_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watches" ADD CONSTRAINT "watches_watchedBotId_fkey" FOREIGN KEY ("watchedBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

