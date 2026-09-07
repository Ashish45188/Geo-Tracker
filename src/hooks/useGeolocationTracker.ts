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

  const watchIdRef = useRef<number | null>(null);
  const bestLocationRef = useRef<GeoLocationPayload | null>(null);
  const lastSavedRef = useRef<{
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    timestamp: number;
  } | null>(null);
  const lastHeartbeatRef = useRef<number>(0);
  const isStoppedRef = useRef<boolean>(false);

  const geoOptions: PositionOptions = {
    enableHighAccuracy: true,
    timeout: 30000,
    maximumAge: 0,
  };
  const initialGeoOptions: PositionOptions = {
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: 30000,
  };

  const processPosition = useCallback(
    async (pos: GeolocationPosition) => {
      if (isStoppedRef.current || !sessionId) return;

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

      // Check if update should be saved to database
      const decision = shouldRecordLocationUpdate(lastSavedRef.current, {
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracy: payload.accuracy,
        timestamp: payload.timestamp,
      });

      let isSaved = false;
      try {
        await db.updateCurrentLocation(sessionId, payload);
      } catch (err) {
        console.error('Failed to update current location:', err);
      }

      if (decision.shouldRecord) {
        try {
          await db.recordLocationUpdate(sessionId, payload);
          lastSavedRef.current = {
            latitude: payload.latitude,
            longitude: payload.longitude,
            accuracy: payload.accuracy,
            timestamp: payload.timestamp,
          };
          isSaved = true;
        } catch (err) {
          console.error('Failed to record location update to database:', err);
        }
      }

      if (!isSaved && Date.now() - lastHeartbeatRef.current >= 15000) {
        lastHeartbeatRef.current = Date.now();
        void db.touchVisitorSession(sessionId);
      }

      const nextUpdateCount = state.updateCount + 1;

      console.log('=== LIVE ROUTE DEBUG ===');
      console.log('Permission: granted');
      console.log('Session ID:', sessionId);
      console.log('First Location:', nextUpdateCount === 1 ? 'received' : 'subsequent');
      console.log('Location Saved:', isSaved);
      console.log('Location Updates:', nextUpdateCount);

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

      if (onLocationUpdate) {
        onLocationUpdate(payload, isSaved);
      }
    },
    [sessionId, onLocationUpdate]
  );

  const handlePositionError = useCallback(
    (err: GeolocationPositionError) => {
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

      setState((prev) => ({
        ...prev,
        error: errorMessage,
        isAcquiringInitial: false,
        // For temporary GPS errors (TIMEOUT / POSITION_UNAVAILABLE), keep tracking active!
        // Preserve latestLocation and bestLocation so last known location remains visible.
        isTracking: isFatal ? false : prev.isTracking,
      }));

      if (sessionId && isFatal) {
        db.updateVisitorSessionStatus(sessionId, status, errorMessage);
      }
      if (onStatusChange) {
        onStatusChange(status, errorMessage);
      }
    },
    [sessionId, onStatusChange]
  );

  // Stop tracking cleanly
  const stopTracking = useCallback(
    async (reason: 'visitor' | 'admin' = 'visitor') => {
      isStoppedRef.current = true;

      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }

      const status: SessionStatus =
        reason === 'visitor' ? 'stopped_by_visitor' : 'stopped_by_admin';

      setState((prev) => ({
        ...prev,
        isTracking: false,
        isAcquiringInitial: false,
        stoppedByAdmin: reason === 'admin',
      }));

      if (sessionId) {
        await db.updateVisitorSessionStatus(
          sessionId,
          status,
          reason === 'visitor' ? 'Visitor stopped location sharing' : 'Admin stopped session'
        );
      }

      if (onStatusChange) {
        onStatusChange(
          status,
          reason === 'visitor' ? 'Stopped by visitor' : 'Location sharing session ended by administrator.'
        );
      }
    },
    [sessionId, onStatusChange]
  );

  // Start continuous high accuracy tracking
  const startTracking = useCallback(() => {
    if (!navigator.geolocation) {
      setState((prev) => ({
        ...prev,
        error: 'Geolocation is not supported by your browser.',
        isAcquiringInitial: false,
      }));
      return;
    }

    isStoppedRef.current = false;
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    setState((prev) => ({
      ...prev,
      isTracking: true,
      isAcquiringInitial: prev.latestLocation === null,
      error: null,
      warning: null,
      stoppedByAdmin: false,
    }));

    // Start watchPosition immediately so tracking is always active
    const watchId = navigator.geolocation.watchPosition(
      processPosition,
      handlePositionError,
      geoOptions
    );
    watchIdRef.current = watchId;

    // Also attempt a fast initial fix in parallel to populate location faster
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!isStoppedRef.current) {
          processPosition(pos);
        }
      },
      (err) => {
        // Log fast fix failure without stopping watchPosition
        console.warn('Initial fast geolocation fix failed, watchPosition continuing:', err.message);
        if (err.code === err.PERMISSION_DENIED) {
          handlePositionError(err);
        }
      },
      initialGeoOptions
    );
  }, [processPosition, handlePositionError]);

  // Automatically reconnect/resume tracking when network comes back online or page becomes visible/foreground
  useEffect(() => {
    const handleOnline = () => {
      console.log('=== NETWORK RECONNECTED === Resuming tracking...');
      if (isActive && sessionId && !isStoppedRef.current) {
        startTracking();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('=== PAGE FOREGROUND RE-ACTIVATED === Resuming location tracking...');
        if (isActive && sessionId && !isStoppedRef.current) {
          startTracking();
        }
      }
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isActive, sessionId, startTracking]);

  // Effect to trigger tracking when isActive and sessionId are present
  useEffect(() => {
    if (isActive && sessionId && !state.isTracking && !isStoppedRef.current) {
      startTracking();
    }

    return () => {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [isActive, sessionId]);

  // Keep the session alive even when the device is stationary and the browser
  // does not emit a new geolocation callback. Sends heartbeat every 5 seconds.
  useEffect(() => {
    if (!isActive || !sessionId) return;

    // Initial touch on active
    console.log('=== SESSION HEARTBEAT ===');
    console.log('sessionId:', sessionId);
    console.log('timestamp:', new Date().toISOString());
    console.log('status: active');
    void db.touchVisitorSession(sessionId);

    const heartbeat = window.setInterval(() => {
      if (!isStoppedRef.current) {
        console.log('=== SESSION HEARTBEAT ===');
        console.log('sessionId:', sessionId);
        console.log('timestamp:', new Date().toISOString());
        console.log('status: active');
        void db.touchVisitorSession(sessionId);
      }
    }, 5000);

    return () => window.clearInterval(heartbeat);
  }, [isActive, sessionId]);

  // Real-time listener for admin stopping this session
  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = db.subscribeToSession(sessionId, (session) => {
      if (session.status === 'stopped_by_admin') {
        stopTracking('admin');
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
