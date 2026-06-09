import { Prisma } from "@prisma/client";

export const isDatabaseConnectionError = (error: unknown) => {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const errorLike = error as {
    readonly code?: unknown;
    readonly errorCode?: unknown;
    readonly name?: unknown;
  };

  return (
    errorLike.name === "PrismaClientInitializationError" ||
    errorLike.code === "P1001" ||
    errorLike.errorCode === "P1001"
  );
};

export const databaseUnavailablePayload = {
  error: "database_unavailable",
  message: "auth.errors.databaseUnavailable",
} as const;
