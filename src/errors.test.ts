import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { isDatabaseConnectionError } from "./errors.js";

describe("error helpers", () => {
  it("detects Prisma initialization errors", () => {
    expect(
      isDatabaseConnectionError(
        new Prisma.PrismaClientInitializationError(
          "Could not connect to database.",
          "6.19.3",
          "P1001",
        ),
      ),
    ).toBe(true);
  });

  it("detects Prisma P1001-like errors from serialized logs", () => {
    expect(
      isDatabaseConnectionError({
        errorCode: "P1001",
        name: "PrismaClientInitializationError",
      }),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isDatabaseConnectionError(new Error("Invalid token."))).toBe(false);
  });
});
