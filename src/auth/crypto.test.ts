import { describe, expect, it } from "vitest";

import {
  buildMagicLink,
  hashToken,
  isApplePrivateRelayEmail,
  normalizeEmail,
} from "./crypto.js";

describe("auth crypto helpers", () => {
  it("normalizes email addresses", () => {
    expect(normalizeEmail("  USER@Example.COM ")).toBe("user@example.com");
  });

  it("detects Apple private relay emails", () => {
    expect(isApplePrivateRelayEmail("abc@privaterelay.appleid.com")).toBe(true);
    expect(isApplePrivateRelayEmail("user@example.com")).toBe(false);
  });

  it("hashes tokens deterministically without exposing the raw token", () => {
    const hash = hashToken("raw-token");

    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashToken("raw-token"));
    expect(hash).not.toContain("raw-token");
  });

  it("builds magic links with a token query param", () => {
    expect(buildMagicLink("driveyou://auth/magic-link", "abc")).toBe(
      "driveyou://auth/magic-link?token=abc",
    );
  });
});
