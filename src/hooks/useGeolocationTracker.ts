import { useState, useEffect, useRef, useCallback } from 'react';
import { GeoLocationPayload, SessionStatus } from '../types';
import { db } from '../services/db';
import { shouldRecordLocationUpdate } from '../utils/geo';

export interface UseGeolocationTrackerProps {
  sessionId: string | null;
  isActive: boolean;
  onStatusChange?: (status: SessionStatus, reason?: string) => void;
  onLocationUpdate?: (payload: GeoLocationPayload, isSaved: boolean) => void;
}

export interface GeolocationState {
  isTracking: boolean;
  isAcquiringInitial: boolean;
  latestLocation: GeoLocationPayload | null;
  bestLocation: GeoLocationPayload | null;
  lastSavedLocation: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    timestamp: number;
  } | null;
  error: string | null;
  warning: string | null;
  updateCount: number;
  stoppedByAdmin: boolean;
}

export function useGeolocationTracker({
  sessionId,
  isActive,
  onStatusChange,
  onLocationUpdate,
}: UseGeolocationTrackerProps) {
  const [state, setState] = useState<GeolocationState>({
    isTracking: false,
    isAcquiringInitial: false,
    latestLocation: null,
    bestLocation: null,
    lastSavedLocation: null,
    error: null,
    warning: null,
    updateCount: 0,
    stoppedByAdmin: false,
  });

  // Mutable refs for stable state tracking across renders
  const sessionIdRef = useRef<string | null>(sessionId);
  const isActiveRef = useRef<boolean>(isActive);
  const onStatusChangeRef = useRef(onStatusChange);
  const onLocationUpdateRef = useRef(onLocationUpdate);

  const watchIdRef = useRef<number | null>(null);
  const backupIntervalRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);

  const bestLocationRef = useRef<GeoLocationPayload | null>(null);
  const lastSavedRef = useRef<{
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    timestamp: number;
  } | null>(null);
  const isStoppedRef = useRef<boolean>(false);
  const isTrackingActiveRef = useRef<boolean>(false);
  const errorCountRef = useRef<number>(0);

  // Synchronize mutable refs on every render
  useEffect(() => {
    sessionIdRef.current = sessionId;
    isActiveRef.current = isActive;
    onStatusChangeRef.current = onStatusChange;
    onLocationUpdateRef.current = onLocationUpdate;
  }, [sessionId, isActive, onStatusChange, onLocationUpdate]);

  const geoOptions: PositionOptions = {
    enableHighAccuracy: true,
    timeout: 30000,
    maximumAge: 0,
  };

  const initialGeoOptions: PositionOptions = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 5000,
  };

  // Helper to send periodic heartbeat to database
  const sendHeartbeat = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (isStoppedRef.current || !isActiveRef.current || !currentSessionId) {
      return;
    }

    console.log(`[TRACKER] Heartbeat sent for session: ${currentSessionId} at ${new Date().toISOString()}`);
    try {
      await db.touchVisitorSession(currentSessionId);
    } catch (err) {
      console.error(`[TRACKER] Heartbeat update error for session ${currentSessionId}:`, err);
    }
  }, []);

  // Process incoming position from watchPosition or getCurrentPosition
  const processPosition = useCallback(
    async (pos: GeolocationPosition) => {
      const currentSessionId = sessionIdRef.current;
      if (isStoppedRef.current || !isActiveRef.current || !currentSessionId) {
        return;
      }

      // Reset non-fatal error count on successful location fix
      errorCountRef.current = 0;

      const payload: GeoLocationPayload = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy !== null && !isNaN(pos.coords.accuracy) ? pos.coords.accuracy : null,
        altitude: pos.coords.altitude !== null && !isNaN(pos.coords.altitude) ? pos.coords.altitude : null,
        altitudeAccuracy:
          pos.coords.altitudeAccuracy !== null && !isNaN(pos.coords.altitudeAccuracy)
            ? pos.coords.altitudeAccuracy
            : null,
        heading: pos.coords.heading !== null && !isNaN(pos.coords.heading) ? pos.coords.heading : null,
        speed: pos.coords.speed !== null && !isNaN(pos.coords.speed) ? pos.coords.speed : null,
        timestamp: pos.timestamp || Date.now(),
      };

      console.log(
        `[TRACKER] GPS update received: session=${currentSessionId}, lat=${payload.latitude.toFixed(
          5
        )}, lng=${payload.longitude.toFixed(5)}, accuracy=${payload.accuracy ? Math.round(payload.accuracy) + 'm' : 'N/A'}`
      );

      // Check for poor accuracy warning
      let warningMessage: string | null = null;
      if (payload.accuracy && payload.accuracy > 50) {
        warningMessage = `GPS accuracy is currently ±${Math.round(payload.accuracy)} meters. Waiting for a better location...`;
      }

      // Update best accuracy location
      if (
        !bestLocationRef.current ||
        (payload.accuracy &&
          bestLocationRef.current.accuracy &&
          payload.accuracy < bestLocationRef.current.accuracy) ||
        (!bestLocationRef.current.accuracy && payload.accuracy)
      ) {
        bestLocationRef.current = payload;
      }

      // Check if update should be saved to location history database
      const decision = shouldRecordLocationUpdate(lastSavedRef.current, {
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracy: payload.accuracy,
        timestamp: payload.timestamp,
      });

      let isSaved = false;

      // Always update current location state and timestamp in database
      try {
        await db.updateCurrentLocation(currentSessionId, payload);
      } catch (err) {
        console.error(`[TRACKER] Failed to update current location for session ${currentSessionId}:`, err);
      }

      if (decision.shouldRecord) {
        try {
          await db.recordLocationUpdate(currentSessionId, payload);
          lastSavedRef.current = {
            latitude: payload.latitude,
            longitude: payload.longitude,
            accuracy: payload.accuracy,
            timestamp: payload.timestamp,
          };
          isSaved = true;
          console.log(`[TRACKER] Location update saved to history: session=${currentSessionId}, reason=${decision.reason}`);
        } catch (err) {
          console.error(`[TRACKER] Failed to record location update to history for session ${currentSessionId}:`, err);
        }
      }

      console.log(`[TRACKER] Database update completed: session=${currentSessionId}, isSaved=${isSaved}`);

      setState((prev) => ({
        ...prev,
        latestLocation: payload,
        bestLocation: bestLocationRef.current,
        lastSavedLocation: lastSavedRef.current,
        warning: warningMessage,
        error: null,
        isAcquiringInitial: false,
        isTracking: true,
        updateCount: prev.updateCount + 1,
      }));

      if (onLocationUpdateRef.current) {
        onLocationUpdateRef.current(payload, isSaved);
      }
    },
    []
  );

  // Handle position errors
  const handlePositionError = useCallback(
    (err: GeolocationPositionError) => {
      const currentSessionId = sessionIdRef.current;
      console.warn(`[TRACKER] GPS Position Error (code ${err.code}): ${err.message}`);

      let errorMessage = 'An unknown geolocation error occurred.';
      let status: SessionStatus = 'location_unavailable';
      const isFatal = err.code === err.PERMISSION_DENIED;

      switch (err.code) {
        case err.PERMISSION_DENIED:
          errorMessage = 'Location permission was denied.';
          status = 'permission_denied';
          break;
        case err.POSITION_UNAVAILABLE:
          errorMessage = 'Your device could not determine a location.';
          status = 'location_unavailable';
          break;
        case err.TIMEOUT:
          errorMessage = 'Location request timed out. Retrying...';
          status = 'location_unavailable';
          break;
      }

      if (!isFatal) {
        errorCountRef.current += 1;
        console.log(`[TRACKER] Consecutive non-fatal GPS errors: ${errorCountRef.current}`);

        // If watcher produces repeated errors (>= 3), attempt to restart watcher
        if (errorCountRef.current >= 3 && navigator.geolocation && !isStoppedRef.current) {
          console.log('[TRACKER] Excessive GPS errors detected. Restarting watchPosition watcher...');
          errorCountRef.current = 0;
          if (watchIdRef.current !== null) {
            navigator.geolocation.clearWatch(watchIdRef.current);
            watchIdRef.current = null;
          }
          watchIdRef.current = navigator.geolocation.watchPosition(
            processPosition,
            handlePositionError,
            geoOptions
          );
        }
      } else {
        isTrackingActiveRef.current = false;
      }

      setState((prev) => ({
        ...prev,
        error: errorMessage,
        isAcquiringInitial: false,
        // Keep tracking active for non-fatal GPS errors
        isTracking: isFatal ? false : prev.isTracking,
      }));

      if (currentSessionId && isFatal) {
        void db.updateVisitorSessionStatus(currentSessionId, status, errorMessage);
      }
      if (onStatusChangeRef.current) {
        onStatusChangeRef.current(status, errorMessage);
      }
    },
    [processPosition]
  );

  // Stop tracking cleanly
  const stopTracking = useCallback(
    async (reason: 'visitor' | 'admin' = 'visitor') => {
      const currentSessionId = sessionIdRef.current;
      console.log(`[TRACKER] Tracker stopping: session=${currentSessionId}, reason=${reason}`);

      isStoppedRef.current = true;
      isTrackingActiveRef.current = false;

      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (backupIntervalRef.current !== null) {
        window.clearInterval(backupIntervalRef.current);
        backupIntervalRef.current = null;
      }
      if (heartbeatIntervalRef.current !== null) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }

      const status: SessionStatus =
        reason === 'visitor' ? 'stopped_by_visitor' : 'stopped_by_admin';

      setState((prev) => ({
        ...prev,
        isTracking: false,
        isAcquiringInitial: false,
        stoppedByAdmin: reason === 'admin',
      }));

      if (currentSessionId) {
        await db.updateVisitorSessionStatus(
          currentSessionId,
          status,
          reason === 'visitor' ? 'Visitor stopped location sharing' : 'Admin stopped session'
        );
      }

      if (onStatusChangeRef.current) {
        onStatusChangeRef.current(
          status,
          reason === 'visitor' ? 'Stopped by visitor' : 'Location sharing session ended by administrator.'
        );
      }
    },
    []
  );

  // Start continuous high accuracy tracking with backup refresh & heartbeat
  const startTracking = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    if (!navigator.geolocation) {
      console.error('[TRACKER] Geolocation is not supported by this browser.');
      setState((prev) => ({
        ...prev,
        error: 'Geolocation is not supported by your browser.',
        isAcquiringInitial: false,
      }));
      return;
    }

    console.log(`[TRACKER] Tracker started for session: ${currentSessionId}`);

    isStoppedRef.current = false;
    isTrackingActiveRef.current = true;
    errorCountRef.current = 0;

    // Clear any existing watchers or timers before starting new ones
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (backupIntervalRef.current !== null) {
      window.clearInterval(backupIntervalRef.current);
      backupIntervalRef.current = null;
    }
    if (heartbeatIntervalRef.current !== null) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    setState((prev) => ({
      ...prev,
      isTracking: true,
      isAcquiringInitial: prev.latestLocation === null,
      error: null,
      warning: null,
      stoppedByAdmin: false,
    }));

    // 1. Main Continuous watchPosition
    const watchId = navigator.geolocation.watchPosition(
      processPosition,
      handlePositionError,
      geoOptions
    );
    watchIdRef.current = watchId;

    // 2. Initial fast fix
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!isStoppedRef.current) {
          processPosition(pos);
        }
      },
      (err) => {
        console.warn('[TRACKER] Initial fast geolocation fix failed, watchPosition continuing:', err.message);
        if (err.code === err.PERMISSION_DENIED) {
          handlePositionError(err);
        }
      },
      initialGeoOptions
    );

    // 3. Backup periodic location refresh (every 20 seconds)
    backupIntervalRef.current = window.setInterval(() => {
      if (!isStoppedRef.current && isActiveRef.current && navigator.geolocation) {
        console.log('[TRACKER] Backup location refresh requested via getCurrentPosition');
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (!isStoppedRef.current) {
              processPosition(pos);
            }
          },
          (err) => {
            console.warn('[TRACKER] Backup getCurrentPosition failed:', err.message);
          },
          initialGeoOptions
        );
      }
    }, 20000);

    // 4. Dedicated heartbeat timer (every 5 seconds)
    void sendHeartbeat();
    heartbeatIntervalRef.current = window.setInterval(() => {
      void sendHeartbeat();
    }, 5000);
  }, [processPosition, handlePositionError, sendHeartbeat]);

  // Handle mobile browser lifecycle and connectivity events (visibilitychange, focus, blur, online, offline)
  useEffect(() => {
    const handleOnline = () => {
      console.log('[TRACKER] Mobile event: network online. Resuming tracking & sending heartbeat...');
      if (isActiveRef.current && sessionIdRef.current && !isStoppedRef.current) {
        void sendHeartbeat();
        startTracking();
      }
    };

    const handleOffline = () => {
      console.warn('[TRACKER] Mobile event: network offline.');
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[TRACKER] Mobile event: visibilitychange (visible). Resuming location tracking...');
        if (isActiveRef.current && sessionIdRef.current && !isStoppedRef.current) {
          void sendHeartbeat();
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              processPosition,
              handlePositionError,
              initialGeoOptions
            );
          }
          if (watchIdRef.current === null) {
            startTracking();
          }
        }
      } else {
        console.log('[TRACKER] Mobile event: visibilitychange (hidden).');
      }
    };

    const handleFocus = () => {
      console.log('[TRACKER] Mobile event: window focus. Refreshing heartbeat & position...');
      if (isActiveRef.current && sessionIdRef.current && !isStoppedRef.current) {
        void sendHeartbeat();
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            processPosition,
            handlePositionError,
            initialGeoOptions
          );
        }
      }
    };

    const handleBlur = () => {
      console.log('[TRACKER] Mobile event: window blur.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
    };
  }, [sendHeartbeat, startTracking, processPosition, handlePositionError]);

  // Main lifecycle effect: start tracking when active & session present
  useEffect(() => {
    if (isActive && sessionId && !isTrackingActiveRef.current && !isStoppedRef.current) {
      startTracking();
    }

    return () => {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (backupIntervalRef.current !== null) {
        window.clearInterval(backupIntervalRef.current);
        backupIntervalRef.current = null;
      }
      if (heartbeatIntervalRef.current !== null) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      isTrackingActiveRef.current = false;
    };
  }, [isActive, sessionId, startTracking]);

  // Real-time listener for admin stopping this session
  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = db.subscribeToSession(sessionId, (session) => {
      if (session.status === 'stopped_by_admin') {
        console.log(`[TRACKER] Admin stop signal received for session: ${sessionId}`);
        void stopTracking('admin');
      }
    });

    return () => {
      unsubscribe();
    };
  }, [sessionId, stopTracking]);

  return {
    ...state,
    startTracking,
    stopTracking,
  };
}
