/**
 * Geolocation mathematical and formatting helpers
 */

// Calculate Haversine distance between two lat/lng coordinates in meters
export function calculateDistanceInMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export function formatDistanceInMeters(distance: number): string {
  if (distance < 1000) return `${Math.round(distance)} m`;
  return `${(distance / 1000).toFixed(2)} km`;
}

export const MAX_POOR_ACCURACY_METERS = 100; // Ignore GPS points with accuracy worse than ±100m
export const MAX_REALISTIC_SPEED_MPS = 50; // Max speed threshold (50 m/s = 180 km/h) to filter unrealistic jumps

/**
 * Strategy check: Should a new location update be saved as a route history movement point?
 * Validated Movement Rules:
 * 1. Ignore updates with very poor accuracy (> 100m or missing).
 * 2. Apply dynamic, accuracy-aware movement threshold accounting for both previous & new GPS accuracy radii.
 * 3. Validate speed to reject unrealistic GPS teleport jumps (> 180 km/h).
 * 4. Never record periodic updates while stationary (time elapsed alone is NOT movement).
 */
export function shouldRecordLocationUpdate(
  lastSavedLocation: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    timestamp: number;
  } | null,
  newLocation: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    timestamp: number;
  }
): { shouldRecord: boolean; reason: string } {
  const newAcc = newLocation.accuracy !== null && newLocation.accuracy !== undefined && !isNaN(newLocation.accuracy)
    ? newLocation.accuracy
    : 9999;

  // Rule 1: Reject updates with poor accuracy
  if (newAcc > MAX_POOR_ACCURACY_METERS) {
    return {
      shouldRecord: false,
      reason: `Poor GPS accuracy (±${Math.round(newAcc)}m exceeds max ±${MAX_POOR_ACCURACY_METERS}m)`,
    };
  }

  // Initial valid point acquisition
  if (!lastSavedLocation) {
    return { shouldRecord: true, reason: `Initial location fix acquired (±${Math.round(newAcc)}m)` };
  }

  const prevAcc = lastSavedLocation.accuracy !== null && lastSavedLocation.accuracy !== undefined && !isNaN(lastSavedLocation.accuracy)
    ? lastSavedLocation.accuracy
    : 9999;

  const distanceMoved = calculateDistanceInMeters(
    lastSavedLocation.latitude,
    lastSavedLocation.longitude,
    newLocation.latitude,
    newLocation.longitude
  );

  // Rule 2: Accuracy-aware movement threshold (accounts for GPS accuracy radius of both points)
  // E.g., if accuracy is ±80m for both, required distance = max(15, 0.6 * (80 + 80)) = 96m
  const requiredDistance = Math.max(15, 0.6 * (prevAcc + newAcc));

  if (distanceMoved < requiredDistance) {
    return {
      shouldRecord: false,
      reason: `Stationary GPS drift ignored (${Math.round(distanceMoved)}m < threshold ${Math.round(requiredDistance)}m)`,
    };
  }

  // Rule 3: Speed validation against unrealistic jumps
  const timeDiffSec = Math.max(0.1, (newLocation.timestamp - lastSavedLocation.timestamp) / 1000);
  const speedMps = distanceMoved / timeDiffSec;

  if (speedMps > MAX_REALISTIC_SPEED_MPS) {
    return {
      shouldRecord: false,
      reason: `Unrealistic speed jump rejected (${Math.round(speedMps * 3.6)} km/h > ${Math.round(MAX_REALISTIC_SPEED_MPS * 3.6)} km/h)`,
    };
  }

  return {
    shouldRecord: true,
    reason: `Validated physical movement detected (${Math.round(distanceMoved)}m >= threshold ${Math.round(requiredDistance)}m)`,
  };
}

export function formatAccuracy(accuracy?: number | null): string {
  if (accuracy === undefined || accuracy === null || isNaN(accuracy)) {
    return '± Unknown';
  }
  const rounded = Math.round(accuracy);
  return `±${rounded} meters`;
}

export function formatCoordinates(lat: number, lng: number, digits = 6): string {
  return `${lat.toFixed(digits)}, ${lng.toFixed(digits)}`;
}

export function getGoogleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function formatTimestamp(isoOrTimestamp: string | number | Date): string {
  try {
    const d = new Date(isoOrTimestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return 'Just now';
  }
}

export function formatDateTime(isoOrTimestamp: string | number | Date): string {
  try {
    const d = new Date(isoOrTimestamp);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch {
    return 'N/A';
  }
}

export function isAccuracyPoor(accuracy?: number | null): boolean {
  if (accuracy === undefined || accuracy === null) return false;
  return accuracy > 50; // Threshold for warning message
}

export interface RoutePoint {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  created_at?: string;
  timestamp?: number;
}

/**
 * Filter out invalid coordinates, poor accuracy readings, stationary GPS drift, and unrealistic speed jumps.
 */
export function filterRoutePoints<T extends RoutePoint>(points: T[]): T[] {
  if (!Array.isArray(points)) return [];

  const filtered: T[] = [];

  for (const p of points) {
    if (!p) continue;
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    const acc = p.accuracy !== null && p.accuracy !== undefined && !isNaN(Number(p.accuracy))
      ? Number(p.accuracy)
      : null;

    if (
      isNaN(lat) ||
      isNaN(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      continue;
    }

    // Filter out points with poor accuracy (> 100 meters)
    if (acc !== null && acc > MAX_POOR_ACCURACY_METERS) {
      continue;
    }

    if (filtered.length > 0) {
      const prev = filtered[filtered.length - 1];
      const dist = calculateDistanceInMeters(prev.latitude, prev.longitude, lat, lng);

      const prevAcc = prev.accuracy !== null && prev.accuracy !== undefined ? prev.accuracy : 50;
      const currAcc = acc !== null ? acc : 50;

      // Accuracy-aware minimum movement threshold
      const reqDist = Math.max(15, 0.6 * (prevAcc + currAcc));
      if (dist < reqDist) {
        continue; // Skip stationary drift / jitter points
      }

      // Speed validation if timestamps exist
      const pTime = p.timestamp || (p.created_at ? new Date(p.created_at).getTime() : null);
      const prevTime = prev.timestamp || (prev.created_at ? new Date(prev.created_at).getTime() : null);

      if (pTime && prevTime && pTime > prevTime) {
        const timeDiffSec = (pTime - prevTime) / 1000;
        if (timeDiffSec > 0) {
          const speedMps = dist / timeDiffSec;
          if (speedMps > MAX_REALISTIC_SPEED_MPS) {
            continue; // Skip unrealistic jump
          }
        }
      }
    }

    filtered.push({ ...p, latitude: lat, longitude: lng, accuracy: acc });
  }

  return filtered;
}

/**
 * Calculate cumulative distance across consecutive validated geographic coordinates in meters.
 * Excludes duplicate/jitter points and inaccurate coordinates.
 */
export function calculateCumulativeDistance(
  points: Array<{ latitude: number; longitude: number; accuracy?: number | null; created_at?: string; timestamp?: number }>
): number {
  if (!Array.isArray(points) || points.length < 2) return 0;

  const validPoints = filterRoutePoints(points);
  if (validPoints.length < 2) return 0;

  let totalMeters = 0;
  for (let i = 0; i < validPoints.length - 1; i++) {
    const p1 = validPoints[i];
    const p2 = validPoints[i + 1];
    totalMeters += calculateDistanceInMeters(p1.latitude, p1.longitude, p2.latitude, p2.longitude);
  }

  return totalMeters;
}

/**
 * Format time duration between start and end timestamps into human readable string.
 */
export function formatDuration(
  startIsoOrMs?: string | number | Date | null,
  endIsoOrMs?: string | number | Date | null
): string {
  if (!startIsoOrMs) return 'N/A';

  try {
    const start = new Date(startIsoOrMs).getTime();
    const end = endIsoOrMs ? new Date(endIsoOrMs).getTime() : Date.now();
    const diffMs = Math.max(0, end - start);

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds} sec${seconds === 1 ? '' : 's'}`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'}`;

    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    if (hours < 24) {
      return remainingMins > 0
        ? `${hours} hr${hours === 1 ? '' : 's'} ${remainingMins} min${remainingMins === 1 ? '' : 's'}`
        : `${hours} hr${hours === 1 ? '' : 's'}`;
    }

    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0
      ? `${days} day${days === 1 ? '' : 's'} ${remainingHours} hr${remainingHours === 1 ? '' : 's'}`
      : `${days} day${days === 1 ? '' : 's'}`;
  } catch {
    return 'N/A';
  }
}
