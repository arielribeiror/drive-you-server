import { describe, expect, it } from "vitest";

import { getMaintenanceSchedule } from "./maintenance-baseline.js";

describe("maintenance baseline schedules", () => {
  it("uses the conservative interval for severe engine oil usage", () => {
    expect(getMaintenanceSchedule("engine_oil", "severe")).toEqual({
      intervalKm: 5_000,
      intervalMonths: 6,
      intervalDays: null,
    });
  });

  it("uses the longer interval for light engine oil usage", () => {
    expect(getMaintenanceSchedule("engine_oil", "light")).toEqual({
      intervalKm: 10_000,
      intervalMonths: 12,
      intervalDays: null,
    });
  });

  it("keeps tire pressure ready as a fixed two-week reminder", () => {
    expect(getMaintenanceSchedule("tire_pressure")).toEqual({
      intervalKm: 0,
      intervalMonths: null,
      intervalDays: 14,
    });
  });
});
