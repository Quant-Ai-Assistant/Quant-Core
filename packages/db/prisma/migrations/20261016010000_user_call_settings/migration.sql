-- CreateTable
CREATE TABLE "user_call_settings" (
    "userId" TEXT NOT NULL,
    "secretId" TEXT,
    "modelProvider" TEXT,
    "modelId" TEXT,
    "thinkingLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_call_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_call_settings_secretId_key" ON "user_call_settings"("secretId");

-- AddForeignKey
ALTER TABLE "user_call_settings" ADD CONSTRAINT "user_call_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_call_settings" ADD CONSTRAINT "user_call_settings_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
