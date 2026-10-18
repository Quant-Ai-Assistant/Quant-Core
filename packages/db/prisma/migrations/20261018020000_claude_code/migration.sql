-- AlterTable
ALTER TABLE "bots" ADD COLUMN "claudeCodeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "claudeCodeModel" TEXT,
ADD COLUMN "claudeCodeEffort" TEXT;

-- CreateTable
CREATE TABLE "user_claude_code" (
    "userId" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_claude_code_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_claude_code_secretId_key" ON "user_claude_code"("secretId");

-- AddForeignKey
ALTER TABLE "user_claude_code" ADD CONSTRAINT "user_claude_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_claude_code" ADD CONSTRAINT "user_claude_code_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The Claude Code sign-in belongs to the user, like model, voice and call keys.
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_scope_check";
ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_scope_check"
  CHECK (
    ("kind" IN ('model', 'voice', 'call', 'claude_code') AND "spaceId" IS NULL)
    OR ("kind" NOT IN ('model', 'voice', 'call', 'claude_code') AND "spaceId" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "secrets" VALIDATE CONSTRAINT "secrets_scope_check";
