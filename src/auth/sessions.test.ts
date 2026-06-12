import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { AuthError, verifyAccessToken } from "./sessions.js";

const testJwtSecret = new TextEncoder().encode(
  "drive-you-development-jwt-secret-change-before-production",
);

describe("auth sessions", () => {
  it("wraps expired access tokens as auth errors", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-id")
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(testJwtSecret);

    await expect(verifyAccessToken(expiredToken)).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});
