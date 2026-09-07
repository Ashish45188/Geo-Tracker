import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { SessionWithLocation, LocationUpdate } from '../types';
import { db } from '../services/db';
import { fetchRoadRoute, filterRoutePoints } from '../services/routeService';
import {
  calculateDistanceInMeters,
  formatCoordinates,
  formatAccuracy,
  formatDistanceInMeters,
  formatTimestamp,
  getGoogleMapsUrl,
} from '../utils/geo';
import { ExternalLink, Crosshair, Layers, Navigation, Route } from 'lucide-react';

interface AdminLiveMapProps {
  sessions: SessionWithLocation[];
  selectedSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  locationHistory?: LocationUpdate[];
}

declare global {
  interface Window {
    __openGoogleMapsForSession?: (sessionId: string, fallbackLat: number, fallbackLng: number) => void;
  }
}

export const AdminLiveMap: React.FC<AdminLiveMapProps> = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  locationHistory = [],
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.__openGoogleMapsForSession = async (sessionId: string, fallbackLat: number, fallbackLng: number) => {
      const mapWin = window.open('about:blank', '_blank');
      let lat = fallbackLat;
      let lng = fallbackLng;
      try {
        const latest = await db.getLatestLocation(sessionId);
        if (latest && latest.latitude !== undefined && latest.longitude !== undefined) {
          lat = latest.latitude;
          lng = latest.longitude;
        }
      } catch (err) {
        console.warn('Failed to fetch latest location for Google Maps:', err);
      }
      if (mapWin) {
        mapWin.location.href = getGoogleMapsUrl(lat, lng);
      }
    };
  }, []);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const [developerLocation, setDeveloperLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [routeStats, setRouteStats] = useState<{ distance: number; provider: string; pointCount: number } | null>(null);

  const markersRef = useRef<Map<string, { marker: L.Marker; circle: L.Circle }>>(new Map());
  const historyPolylineRef = useRef<L.Polyline | null>(null);
  const startMarkerRef = useRef<L.Marker | null>(null);
  const finalMarkerRef = useRef<L.Marker | null>(null);
  const historyMarkersRef = useRef<L.CircleMarker[]>([]);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setDeveloperLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      () => {
        // Visitor location sharing remains independent of developer GPS permission.
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    // Default center: Maharashtra (so any visitor within the state is visible by default)
    const map = L.map(mapContainerRef.current, {
      center: [19.7515, 75.7139],
      zoom: 7,
      zoomControl: false,
    });

    // Add clean OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Update Markers when sessions change
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const currentMarkers = markersRef.current;
    const activeSessionIds = new Set<string>();
    const validPositions: L.LatLngExpression[] = [];

    sessions.forEach((session) => {
      if (!session.current_location) return;

      const { latitude, longitude, accuracy, updated_at } = session.current_location;
      const latLng: L.LatLngExpression = [latitude, longitude];
      validPositions.push(latLng);
      activeSessionIds.add(session.id);

      const isActive = session.status === 'active';
      const isSelected = selectedSessionId === session.id;
      const distanceFromDeveloper = developerLocation
        ? calculateDistanceInMeters(
            developerLocation.latitude,
            developerLocation.longitude,
            latitude,
            longitude
          )
        : null;

      // Custom pulsing HTML marker icon
      const markerHtml = `
        <div class="relative flex items-center justify-center">
          ${
            isActive
              ? '<div class="absolute w-8 h-8 rounded-full bg-[#D1FF26]/40 animate-ping"></div>'
              : ''
          }
          <div class="w-6 h-6 rounded-full border border-black shadow-lg flex items-center justify-center text-xs font-bold ${
            isSelected
              ? 'bg-[#D1FF26] text-black ring-4 ring-[#D1FF26]/50'
              : isActive
              ? 'bg-[#D1FF26] text-black'
              : 'bg-[#2A2A30] text-[#8E8E96]'
          }">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
          </div>
        </div>
      `;

      const customIcon = L.divIcon({
        className: 'custom-live-marker',
        html: markerHtml,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -18],
      });

      // Build popup HTML
      const popupHtml = `
        <div class="p-2.5 min-w-[230px] font-mono text-[#F0F0F2] bg-[#0D0D0F]">
          <div class="flex items-center justify-between border-b border-[#28282E] pb-1.5 mb-2">
            <span class="text-[10px] font-bold text-[#8E8E96] uppercase tracking-widest">DEVICE</span>
            <span class="font-bold text-xs text-[#D1FF26]">${session.visitor_id}</span>
          </div>
          <div class="space-y-1.5 text-xs text-[#C4C4C8]">
            <div class="flex justify-between">
              <span class="text-[#8E8E96]">Video Link:</span>
              <span class="font-sans font-medium text-white truncate max-w-[130px]">${session.video_link?.custom_name || 'Direct Link'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-[#8E8E96]">Latitude:</span>
              <span class="font-mono text-white font-medium">${latitude.toFixed(6)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-[#8E8E96]">Longitude:</span>
              <span class="font-mono text-white font-medium">${longitude.toFixed(6)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-[#8E8E96]">Accuracy:</span>
              <span class="font-semibold ${accuracy && accuracy <= 15 ? 'text-[#D1FF26]' : 'text-amber-400'}">
                ${formatAccuracy(accuracy)}
              </span>
            </div>
            <div class="flex justify-between">
              <span class="text-[#8E8E96]">Updated:</span>
              <span class="text-[#F0F0F2]">${formatTimestamp(updated_at)}</span>
            </div>
            ${
              distanceFromDeveloper !== null
                ? `<div class="flex justify-between"><span class="text-[#8E8E96]">Distance from you:</span><span class="text-[#D1FF26]">${formatDistanceInMeters(distanceFromDeveloper)}</span></div>`
                : ''
            }
            <div class="flex justify-between items-center pt-1 border-t border-[#28282E] mt-1">
              <span class="text-[#8E8E96]">Status:</span>
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase ${
                isActive ? 'bg-[#141810] text-[#D1FF26] border border-[#304018]' : 'bg-[#1A1A20] text-[#8E8E96]'
              }">
                ${session.status.toUpperCase()}
              </span>
            </div>
          </div>
          <div class="mt-3 pt-2 border-t border-[#28282E]">
            <button
              type="button"
              onclick="if(window.__openGoogleMapsForSession){window.__openGoogleMapsForSession('${session.id}', ${latitude}, ${longitude});}"
              class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#D1FF26] hover:bg-[#bfe822] text-black rounded-lg text-xs font-mono font-bold uppercase tracking-wider transition cursor-pointer"
            >
              <span>Open Google Maps</span>
              <svg class="w-3.5 h-3.5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </button>
          </div>
        </div>
      `;

      if (currentMarkers.has(session.id)) {
        const item = currentMarkers.get(session.id)!;
        item.marker.setLatLng(latLng);
        item.marker.setIcon(customIcon);
        item.marker.setPopupContent(popupHtml);

        item.circle.setLatLng(latLng);
        item.circle.setRadius(accuracy || 15);
        item.circle.setStyle({
          color: isSelected ? '#D1FF26' : isActive ? '#D1FF26' : '#52525B',
          fillColor: isSelected ? '#D1FF26' : isActive ? '#D1FF26' : '#71717A',
          fillOpacity: isSelected ? 0.25 : 0.15,
        });

        if (isSelected && !item.marker.isPopupOpen()) {
          item.marker.openPopup();
        }
      } else {
        const marker = L.marker(latLng, { icon: customIcon }).addTo(map);
        marker.bindPopup(popupHtml);
        marker.on('click', () => {
          if (onSelectSession) onSelectSession(session.id);
        });

        const circle = L.circle(latLng, {
          radius: accuracy || 15,
          color: isSelected ? '#D1FF26' : isActive ? '#D1FF26' : '#52525B',
          fillColor: isSelected ? '#D1FF26' : isActive ? '#D1FF26' : '#71717A',
          fillOpacity: 0.15,
          weight: 1.5,
        }).addTo(map);

        currentMarkers.set(session.id, { marker, circle });

        if (isSelected) {
          marker.openPopup();
        }
      }
    });

    // Remove obsolete markers
    currentMarkers.forEach((item, id) => {
      if (!activeSessionIds.has(id)) {
        item.marker.remove();
        item.circle.remove();
        currentMarkers.delete(id);
      }
    });

    // Auto center map if selected session exists or fit all markers
    if (selectedSessionId && currentMarkers.has(selectedSessionId)) {
      const target = currentMarkers.get(selectedSessionId)!;
      map.panTo(target.marker.getLatLng(), { animate: true, duration: 0.5 });
    } else if (validPositions.length > 0) {
      const currentBounds = map.getBounds();
      const allWithinView = validPositions.every((pos) => currentBounds.contains(pos));
      if (!allWithinView) {
        const bounds = L.latLngBounds(validPositions);
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
      }
    }
  }, [sessions, selectedSessionId, onSelectSession, developerLocation]);

  // Render ACTUAL ROAD-BASED LIVE TRAVEL ROUTE for selected session
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    let isCancelled = false;

    // Clear previous history layers
    const clearLayers = () => {
      if (historyPolylineRef.current) {
        historyPolylineRef.current.remove();
        historyPolylineRef.current = null;
      }
      if (startMarkerRef.current) {
        startMarkerRef.current.remove();
        startMarkerRef.current = null;
      }
      if (finalMarkerRef.current) {
        finalMarkerRef.current.remove();
        finalMarkerRef.current = null;
      }
      historyMarkersRef.current.forEach((m) => m.remove());
      historyMarkersRef.current = [];
    };

    const validHistory = filterRoutePoints(locationHistory);

    if (validHistory.length <= 1) {
      clearLayers();
      setRouteStats(null);
      return;
    }

    async function loadRoadRoute() {
      const routeResponse = await fetchRoadRoute(locationHistory);
      if (isCancelled) return;

      clearLayers();

      const startPoint = validHistory[0];
      const endPoint = validHistory[validHistory.length - 1];

      // 1. Draw Start Location Marker (Green)
      const startMarkerHtml = `
        <div class="relative flex items-center justify-center">
          <div class="w-6 h-6 rounded-full bg-[#10B981] border-2 border-white shadow-lg flex items-center justify-center text-[10px] font-bold text-white font-mono">
            S
          </div>
        </div>
      `;
      const startIcon = L.divIcon({
        className: 'custom-start-marker',
        html: startMarkerHtml,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const startMarker = L.marker([startPoint.latitude, startPoint.longitude], {
        icon: startIcon,
      }).addTo(map);

      startMarker.bindTooltip(
        `Start Location: ${formatTimestamp(locationHistory[0].created_at)}`,
        { direction: 'top', offset: [0, -10] }
      );
      startMarkerRef.current = startMarker;

      // 2. Draw RED road-matched polyline following actual roads, highways, curves, and turns
      if (routeResponse.ok && routeResponse.route.length > 1) {
        const polyline = L.polyline(routeResponse.route, {
          color: '#EF4444', // Red road travel route
          weight: 5,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(map);

        historyPolylineRef.current = polyline;

        // Check if current session is stopped/completed to add Final Location marker
        const selectedSess = sessions.find((s) => s.id === selectedSessionId);
        const isStopped = selectedSess && selectedSess.status !== 'active';

        if (isStopped && endPoint) {
          const finalMarkerHtml = `
            <div class="relative flex items-center justify-center">
              <div class="w-6 h-6 rounded-full bg-[#EF4444] border-2 border-white shadow-lg flex items-center justify-center text-[10px] font-bold text-white font-mono">
                F
              </div>
            </div>
          `;
          const finalIcon = L.divIcon({
            className: 'custom-final-marker',
            html: finalMarkerHtml,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          });

          const finalMarker = L.marker([endPoint.latitude, endPoint.longitude], {
            icon: finalIcon,
          }).addTo(map);

          finalMarker.bindTooltip(
            `Final Location: ${formatTimestamp(locationHistory[locationHistory.length - 1].created_at)}`,
            { direction: 'top', offset: [0, -10] }
          );
          finalMarkerRef.current = finalMarker;
        }

        console.log('=== LIVE ROUTE DEBUG ===');
        console.log('Road Route Generated: true');
        console.log('Red Route Rendered: true');
        console.log('Route Points:', routeResponse.route.length);

        // Fit bounds to encompass the entire road route
        const bounds = L.latLngBounds(routeResponse.route);
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });

        setRouteStats({
          distance: routeResponse.distance || 0,
          provider: routeResponse.provider || 'osrm',
          pointCount: routeResponse.route.length,
        });
      }
    }

    loadRoadRoute();

    return () => {
      isCancelled = true;
    };
  }, [locationHistory]);

  const handleFitAll = () => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const positions: L.LatLngExpression[] = [];
    sessions.forEach((s) => {
      if (s.current_location) {
        positions.push([s.current_location.latitude, s.current_location.longitude]);
      }
    });

    if (positions.length > 0) {
      map.fitBounds(L.latLngBounds(positions), { padding: [50, 50], maxZoom: 16 });
    }
  };

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const selectedDistance =
    selectedSession?.current_location && developerLocation
      ? calculateDistanceInMeters(
          developerLocation.latitude,
          developerLocation.longitude,
          selectedSession.current_location.latitude,
          selectedSession.current_location.longitude
        )
      : null;

  return (
    <div className="relative w-full h-[550px] lg:h-[600px] rounded-2xl overflow-hidden border border-[#222226] bg-[#121215] shadow-xl">
      {/* Map Element */}
      <div ref={mapContainerRef} className="w-full h-full z-0" />

      {/* Floating Map Controls & Stats Overlay */}
      <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 pointer-events-none">
        <div className="pointer-events-auto bg-[#121215]/95 backdrop-blur border border-[#28282E] rounded-xl p-3 shadow-xl flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#D1FF26] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#D1FF26]"></span>
            </span>
            <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
              {sessions.filter((s) => s.status === 'active').length} Active Transmitters
            </span>
          </div>
          <button
            onClick={handleFitAll}
            className="px-2.5 py-1 text-xs font-mono bg-[#18181C] hover:bg-[#222228] text-[#D0D0D5] rounded-lg border border-[#2A2A30] flex items-center gap-1 transition cursor-pointer"
            title="Fit all markers in view"
          >
            <Crosshair className="w-3.5 h-3.5 text-[#D1FF26]" />
            <span>Fit All</span>
          </button>
        </div>

        {/* Road Route Active Badge Overlay */}
        {selectedSession && locationHistory.length > 1 && (
          <div className="pointer-events-auto bg-[#121215]/95 backdrop-blur border border-[#EF4444]/60 rounded-xl p-3 shadow-xl flex items-center gap-2 text-xs font-mono">
            <Route className="w-4 h-4 text-[#EF4444]" />
            <div>
              <div className="flex items-center gap-1.5 font-bold text-[#EF4444]">
                <span>ACTUAL ROAD TRAVEL ROUTE</span>
                <span className="w-2 h-2 rounded-full bg-[#EF4444] animate-pulse"></span>
              </div>
              <div className="text-[11px] text-[#A0A0AA]">
                {routeStats && routeStats.distance > 0
                  ? `Road Distance: ${formatDistanceInMeters(routeStats.distance)}`
                  : 'Road-matched trajectory active'}
              </div>
            </div>
          </div>
        )}

        {selectedSession && selectedSession.current_location && (
          <div className="pointer-events-auto bg-[#121215]/95 backdrop-blur border border-[#D1FF26]/50 rounded-xl p-3 shadow-2xl max-w-xs text-xs space-y-1.5 animate-fadeIn font-mono">
            <div className="flex items-center justify-between pb-1 border-b border-[#222226]">
              <span className="font-bold text-[#D1FF26] flex items-center gap-1">
                <Navigation className="w-3.5 h-3.5 text-[#D1FF26]" />
                {selectedSession.visitor_id}
              </span>
              <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold uppercase tracking-wider ${
                selectedSession.status === 'active'
                  ? 'bg-[#141810] text-[#D1FF26] border-[#304018]'
                  : 'bg-rose-950/40 text-rose-400 border-rose-800/50'
              }`}>
                {selectedSession.status === 'active' ? '🟢 LIVE' : '🔴 DISCONNECTED'}
              </span>
            </div>
            {selectedSession.status !== 'active' && (
              <div className="text-[10px] text-rose-400 font-sans font-medium">
                Location sharing stopped
              </div>
            )}
            <div className="flex justify-between text-[#C4C4C8]">
              <span className="text-[#8E8E96]">Coordinates:</span>
              <span className="font-mono text-white font-medium">
                {formatCoordinates(
                  selectedSession.current_location.latitude,
                  selectedSession.current_location.longitude,
                  5
                )}
              </span>
            </div>
            <div className="flex justify-between text-[#C4C4C8]">
              <span className="text-[#8E8E96]">GPS Accuracy:</span>
              <span className="font-semibold text-[#D1FF26]">
                {formatAccuracy(selectedSession.current_location.accuracy)}
              </span>
            </div>
            <div className="flex justify-between text-[#C4C4C8]">
              <span className="text-[#8E8E96]">Reported:</span>
              <span className="text-white">
                {formatTimestamp(selectedSession.current_location.updated_at)}
              </span>
            </div>
            <div className="flex justify-between text-[#C4C4C8]">
              <span className="text-[#8E8E96]">Distance from you:</span>
              <span className="font-semibold text-[#D1FF26]">
                {selectedDistance === null ? 'Allow location' : formatDistanceInMeters(selectedDistance)}
              </span>
            </div>
            <div className="pt-1.5">
              <a
                href={getGoogleMapsUrl(
                  selectedSession.current_location.latitude,
                  selectedSession.current_location.longitude
                )}
                target="_blank"
                rel="noopener noreferrer"
                onClick={async (e) => {
                  e.preventDefault();
                  const mapWin = window.open('about:blank', '_blank');
                  let lat = selectedSession.current_location!.latitude;
                  let lng = selectedSession.current_location!.longitude;
                  try {
                    const latest = await db.getLatestLocation(selectedSession.id);
                    if (latest) {
                      lat = latest.latitude;
                      lng = latest.longitude;
                    }
                  } catch (err) {
                    console.warn('Failed to fetch latest location:', err);
                  }
                  if (mapWin) {
                    mapWin.location.href = getGoogleMapsUrl(lat, lng);
                  }
                }}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-[#D1FF26] hover:bg-[#bfe822] text-black rounded-lg text-[11px] font-bold uppercase tracking-wider transition cursor-pointer"
              >
                <span>Google Maps View</span>
                <ExternalLink className="w-3 h-3 text-black" />
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Map Info Bar at Bottom Left */}
      <div className="absolute bottom-4 left-4 z-10 pointer-events-none">
        <div className="pointer-events-auto bg-[#121215]/90 backdrop-blur px-3 py-1.5 rounded-lg border border-[#222226] text-[11px] font-mono text-[#8E8E96] flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-[#D1FF26]" />
          <span>OpenStreetMap &bull; Road-Matched GPS Telemetry</span>
        </div>
      </div>
    </div>
  );
};
