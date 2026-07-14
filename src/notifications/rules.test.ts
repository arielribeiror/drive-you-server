import { describe, expect, it } from "vitest";

import {
  buildNotificationInputsForVehicles,
  buildOilChangeLoggedNotificationInputs,
  getOilChangeReminderState,
  type NotificationVehicle,
} from "./rules.js";

const now = new Date("2026-07-13T12:00:00.000Z");

const makeVehicle = (
  overrides: Partial<NotificationVehicle> = {},
): NotificationVehicle => ({
  id: "vehicle-1",
  accesses: [{ userId: "owner-1" }, { userId: "shared-1" }],
  brandModel: "Honda Civic",
  currentOdometerKm: 47_500,
  displayName: null,
  maintenanceBaselines: [
    {
      id: "baseline-oil",
      intervalDays: null,
      intervalKm: 5_000,
      intervalMonths: 6,
      item: "engine_oil",
      odometerKm: 43_000,
      performedAt: "2026-02-13T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      usageProfile: "severe",
    },
  ],
  plate: "ABC1D23",
  ...overrides,
});

describe("notification rules", () => {
  it("detects near oil changes by mileage or time", () => {
    expect(
      getOilChangeReminderState(
        makeVehicle().maintenanceBaselines[0],
        47_500,
        now,
      ),
    ).toEqual({
      remainingDays: 30,
      remainingKm: 500,
    });
  });

  it("generates deduped monthly and maintenance notifications for each vehicle access", () => {
    const inputs = buildNotificationInputsForVehicles([makeVehicle()], now);

    expect(inputs).toHaveLength(6);
    expect(
      inputs.filter((input) => input.type === "maintenance_due"),
    ).toHaveLength(2);
    expect(
      inputs.filter((input) => input.type === "preventive_maintenance"),
    ).toHaveLength(2);
    expect(inputs.filter((input) => input.type === "driving_tip")).toHaveLength(
      2,
    );
    expect(
      inputs.every((input) => input.dedupeKey.includes("vehicle-1")),
    ).toBe(true);
    expect(new Set(inputs.map((input) => input.userId))).toEqual(
      new Set(["owner-1", "shared-1"]),
    );
  });

  it("creates oil-change logged notifications only for engine oil baselines", () => {
    const vehicle = makeVehicle();

    expect(
      buildOilChangeLoggedNotificationInputs(
        vehicle,
        vehicle.maintenanceBaselines[0],
      ),
    ).toHaveLength(2);
    expect(
      buildOilChangeLoggedNotificationInputs(vehicle, {
        ...vehicle.maintenanceBaselines[0],
        item: "tires",
      }),
    ).toHaveLength(0);
  });
});
