import { describe, expect, it } from "vitest";

import { getGoogleIdTokenDiagnostics } from "./google.js";

const buildUnsignedJwt = (payload: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");

describe("google token diagnostics", () => {
  it("reports redacted token audiences without verifying the token", () => {
    const diagnostics = getGoogleIdTokenDiagnostics(
      buildUnsignedJwt({
        aud: "123456789012-webclient.apps.googleusercontent.com",
        azp: "123456789012-iosclient.apps.googleusercontent.com",
        iss: "https://accounts.google.com",
      }),
    );

    expect(diagnostics).toMatchObject({
      tokenReadable: true,
      tokenAudience: [
        "123456789012...client.apps.googleusercontent.com",
      ],
      tokenAuthorizedPresenter:
        "123456789012...client.apps.googleusercontent.com",
      tokenIssuer: "https://accounts.google.com",
    });
  });

  it("keeps malformed tokens from breaking auth failure logging", () => {
    expect(getGoogleIdTokenDiagnostics("not-a-jwt")).toMatchObject({
      tokenReadable: false,
      tokenAudience: [],
    });
  });
});
