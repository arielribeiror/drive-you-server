import { describe, expect, it } from "vitest";

import {
  isDeviceNotRegisteredError,
  resolveReceiptStatus,
} from "./push.js";

describe("notification push helpers", () => {
  it("detects unregistered Expo devices", () => {
    expect(isDeviceNotRegisteredError("DeviceNotRegistered")).toBe(true);
    expect(isDeviceNotRegisteredError("MessageRateExceeded")).toBe(false);
    expect(isDeviceNotRegisteredError(null)).toBe(false);
  });

  it("maps Expo receipts to delivery statuses", () => {
    expect(resolveReceiptStatus({ status: "ok" })).toEqual({
      error: null,
      status: "delivered",
    });
    expect(
      resolveReceiptStatus({
        details: { error: "DeviceNotRegistered" },
        message: "gone",
        status: "error",
      }),
    ).toEqual({
      error: "DeviceNotRegistered",
      status: "failed",
    });
  });
});
