import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

let globalPrisma: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!globalPrisma) {
    globalPrisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }
  return globalPrisma;
}

export const prisma = getPrismaClient();
