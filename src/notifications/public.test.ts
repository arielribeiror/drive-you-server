import { describe, expect, it } from "vitest";

import { toPublicNotification } from "./public.js";

describe("notification public mapping", () => {
  it("serializes notification dates and read state", () => {
    expect(
      toPublicNotification({
        id: "notification-1",
        createdAt: new Date("2026-07-13T12:00:00.000Z"),
        payload: { vehicleTitle: "Civic" },
        readAt: null,
        tone: "warning",
        type: "maintenance_due",
      }),
    ).toEqual({
      id: "notification-1",
      createdAt: "2026-07-13T12:00:00.000Z",
      payload: { vehicleTitle: "Civic" },
      pushStatus: null,
      readAt: null,
      tone: "warning",
      type: "maintenance_due",
    });
  });

  it("maps push delivery status", () => {
    expect(
      toPublicNotification({
        id: "notification-2",
        createdAt: new Date("2026-07-13T12:30:00.000Z"),
        deliveries: [{ status: "pending" }, { status: "sent" }],
        payload: { vehicleTitle: "Civic" },
        pushedAt: null,
        readAt: new Date("2026-07-13T12:31:00.000Z"),
        tone: "info",
        type: "driving_tip",
      }).pushStatus,
    ).toBe("sent");
  });
});
