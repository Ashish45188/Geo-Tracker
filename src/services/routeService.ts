import { LocationUpdate } from '../types';
import { calculateDistanceInMeters, filterRoutePoints, RoutePoint } from '../utils/geo';

export type { RoutePoint };

export interface RouteResponse {
  ok: boolean;
  route: [number, number][]; // Array of [lat, lng]
  distance?: number; // meters
  duration?: number; // seconds
  provider?: string;
  error?: string;
}

export { filterRoutePoints };

/**
 * Ramer-Douglas-Peucker algorithm to simplify long GPS trajectories before sending to route matching API.
 */
function perpendicularDistance(
  pt: RoutePoint,
  lineStart: RoutePoint,
  lineEnd: RoutePoint
): number {
  const dx = lineEnd.longitude - lineStart.longitude;
  const dy = lineEnd.latitude - lineStart.latitude;

  if (dx === 0 && dy === 0) {
    return calculateDistanceInMeters(
      pt.latitude,
      pt.longitude,
      lineStart.latitude,
      lineStart.longitude
    );
  }

  // Convert to approximate meters
  return calculateDistanceInMeters(
    pt.latitude,
    pt.longitude,
    lineStart.latitude,
    lineStart.longitude
  );
}

export function simplifyTrajectory(points: RoutePoint[], epsilon = 0.00005): RoutePoint[] {
  if (points.length <= 2) return points;

  let dmax = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }

  if (dmax > epsilon) {
    const recResults1 = simplifyTrajectory(points.slice(0, index + 1), epsilon);
    const recResults2 = simplifyTrajectory(points.slice(index), epsilon);
    return [...recResults1.slice(0, recResults1.length - 1), ...recResults2];
  } else {
    return [points[0], points[end]];
  }
}

/**
 * Fetch road-based travel route following actual roads, highways, curves, and turns.
 */
export async function fetchRoadRoute(
  history: (LocationUpdate | RoutePoint)[]
): Promise<RouteResponse> {
  const cleanPoints = filterRoutePoints(
    history.map((h) => ({
      latitude: 'latitude' in h ? h.latitude : (h as RoutePoint).latitude,
      longitude: 'longitude' in h ? h.longitude : (h as RoutePoint).longitude,
      accuracy: 'accuracy' in h ? h.accuracy : undefined,
    }))
  );

  if (cleanPoints.length === 0) {
    return { ok: true, route: [], distance: 0, duration: 0 };
  }

  if (cleanPoints.length === 1) {
    return {
      ok: true,
      route: [[cleanPoints[0].latitude, cleanPoints[0].longitude]],
      distance: 0,
      duration: 0,
    };
  }

  // Downsample if point count is large for routing API limits
  const targetPoints = cleanPoints.length > 80 ? simplifyTrajectory(cleanPoints) : cleanPoints;
  const formattedCoords = targetPoints.map((p) => ({
    lat: p.latitude,
    lng: p.longitude,
  }));

  // 1. Try serverless backend API route `/api/route`
  try {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: formattedCoords }),
    });

    if (res.ok) {
      const data: RouteResponse = await res.json();
      if (data.ok && Array.isArray(data.route) && data.route.length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.warn('Backend /api/route fetch failed, switching to OSRM direct client fallback:', err);
  }

  // 2. Client-side OSRM fallback (guarantees operation in pure Vite dev mode or static hosting)
  try {
    const osrmCoordString = formattedCoords.map((p) => `${p.lng},${p.lat}`).join(';');
    const matchUrl = `https://router.project-osrm.org/match/v1/driving/${osrmCoordString}?geometries=geojson&overview=full`;

    const response = await fetch(matchUrl);
    if (response.ok) {
      const data = await response.json();
      if (data.code === 'Ok' && data.matchings && data.matchings.length > 0) {
        const routeCoords: [number, number][] = [];
        let totalDist = 0;
        let totalDur = 0;

        for (const match of data.matchings) {
          totalDist += match.distance || 0;
          totalDur += match.duration || 0;
          if (match.geometry?.coordinates) {
            for (const [lng, lat] of match.geometry.coordinates) {
              routeCoords.push([lat, lng]);
            }
          }
        }

        if (routeCoords.length > 0) {
          return {
            ok: true,
            route: routeCoords,
            distance: totalDist,
            duration: totalDur,
            provider: 'client-osrm-match',
          };
        }
      }
    }

    // Fallback: OSRM Route API
    const routeUrl = `https://router.project-osrm.org/route/v1/driving/${osrmCoordString}?geometries=geojson&overview=full`;
    const routeResponse = await fetch(routeUrl);

    if (routeResponse.ok) {
      const routeData = await routeResponse.json();
      if (routeData.code === 'Ok' && routeData.routes && routeData.routes.length > 0) {
        const primaryRoute = routeData.routes[0];
        const routeCoords: [number, number][] = primaryRoute.geometry.coordinates.map(
          ([lng, lat]: [number, number]) => [lat, lng]
        );

        return {
          ok: true,
          route: routeCoords,
          distance: primaryRoute.distance || 0,
          duration: primaryRoute.duration || 0,
          provider: 'client-osrm-route',
        };
      }
    }
  } catch (fallbackErr) {
    console.error('Client OSRM fallback failed:', fallbackErr);
  }

  return {
    ok: false,
    route: [],
    distance: 0,
    duration: 0,
    provider: 'none',
    error: 'Road routing service unavailable',
  };
}
