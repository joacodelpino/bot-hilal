import { PrismaClient } from "@prisma/client";

/** Instancia única de Prisma compartida por toda la aplicación. */
export const prisma = new PrismaClient();
