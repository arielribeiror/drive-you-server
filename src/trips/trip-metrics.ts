const MAX_PLAUSIBLE_AVERAGE_SPEED_KMH = 240;

export const getAverageSpeedKmh = (
  distanceMeters: number,
  durationSeconds: number,
) => {
  if (durationSeconds <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return (distanceMeters / 1000 / durationSeconds) * 3600;
};

export const isPlausibleTripAverageSpeed = (
  distanceMeters: number,
  durationSeconds: number,
) =>
  getAverageSpeedKmh(distanceMeters, durationSeconds) <=
  MAX_PLAUSIBLE_AVERAGE_SPEED_KMH;

export const getEstimatedOdometerKm = (
  currentOdometerKm: number | null,
  distanceMeters: number,
) => {
  if (currentOdometerKm === null) {
    return null;
  }

  return currentOdometerKm + Math.max(0, Math.round(distanceMeters / 1000));
};
