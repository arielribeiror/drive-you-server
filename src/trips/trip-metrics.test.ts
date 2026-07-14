import { describe, expect, it } from "vitest";

import {
  getAverageSpeedKmh,
  getEstimatedOdometerKm,
  isPlausibleTripAverageSpeed,
} from "./trip-metrics.js";

describe("trip metrics", () => {
  it("calculates average speed from distance and duration", () => {
    expect(getAverageSpeedKmh(12_500, 1_500)).toBe(30);
  });

  it("rejects implausible vehicle averages", () => {
    expect(isPlausibleTripAverageSpeed(12_500, 1_500)).toBe(true);
    expect(isPlausibleTripAverageSpeed(250_000, 1_500)).toBe(false);
  });

  it("increments an existing odometer with the rounded trip distance", () => {
    expect(getEstimatedOdometerKm(42_870, 12_500)).toBe(42_883);
  });

  it("keeps missing odometer values missing", () => {
    expect(getEstimatedOdometerKm(null, 12_500)).toBeNull();
  });
});
