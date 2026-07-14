import type { VehicleMaintenanceBaseline } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { calculateMaintenanceHealth } from "./maintenance-health.js";

const makeBaseline = (
  overrides: Partial<VehicleMaintenanceBaseline> = {},
): VehicleMaintenanceBaseline => ({
  id: "baseline-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  intervalDays: 365,
  intervalKm: 10_000,
  intervalMonths: 12,
  item: "engine_oil",
  odometerKm: 10_000,
  performedAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  usageProfile: "light",
  userId: "user-1",
  vehicleId: "vehicle-1",
  ...overrides,
});

describe("maintenance health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies severe-use trip factors to remaining life", () => {
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));

    const [health] = calculateMaintenanceHealth({
      currentOdometerKm: 19_000,
      maintenanceBaselines: [
        makeBaseline({
          usageProfile: "severe",
        }),
      ],
      trips: [
        {
          averageSpeedKmh: 22,
          distanceMeters: 3_200,
          durationSeconds: 1_000,
          startedAt: new Date("2026-02-01T10:00:00.000Z"),
        },
        {
          averageSpeedKmh: 92,
          distanceMeters: 50_000,
          durationSeconds: 1_950,
          startedAt: new Date("2026-03-01T10:00:00.000Z"),
        },
      ],
    });

    expect(health).toMatchObject({
      factors: {
        cityTripCount: 1,
        coldStartCount: 1,
        highwayTripCount: 1,
        severeUsageProfile: true,
      },
      item: "engine_oil",
      status: "due",
    });
    expect(health.severityMultiplier).toBeGreaterThan(1);
    expect(health.percentRemaining).toBe(0);
  });

  it("keeps a healthy item green when usage is still low", () => {
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    const [health] = calculateMaintenanceHealth({
      currentOdometerKm: 11_000,
      maintenanceBaselines: [makeBaseline()],
      trips: [],
    });

    expect(health.status).toBe("good");
    expect(health.percentRemaining).toBeGreaterThan(80);
    expect(health.remainingKm).toBe(9_000);
  });
});
