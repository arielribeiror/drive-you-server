import { describe, expect, it } from "vitest";

import {
  defaultNotificationPreference,
  isNowInQuietHours,
  notificationPreferenceTypes,
} from "./preferences.js";

describe("notification preferences", () => {
  it("includes trip confirmation with enabled defaults", () => {
    expect(notificationPreferenceTypes).toContain("trip_confirmation");
    expect(defaultNotificationPreference("trip_confirmation")).toMatchObject({
      inAppEnabled: true,
      pushEnabled: true,
      quietHoursEnd: null,
      quietHoursStart: null,
      type: "trip_confirmation",
    });
  });

  it("handles quiet hours that cross midnight", () => {
    const preference = {
      quietHoursEnd: "07:00",
      quietHoursStart: "22:00",
    };

    expect(
      isNowInQuietHours(preference, new Date("2026-07-14T02:30:00")),
    ).toBe(true);
    expect(
      isNowInQuietHours(preference, new Date("2026-07-14T12:00:00")),
    ).toBe(false);
  });
});
