import React, { useState } from 'react';
import { SessionWithLocation } from '../types';
import { db } from '../services/db';
import { formatCoordinates, formatAccuracy, formatTimestamp, getGoogleMapsUrl } from '../utils/geo';
import {
  Radio,
  MapPin,
  StopCircle,
  ExternalLink,
  Navigation,
  Clock,
  ShieldAlert,
  Activity,
  History,
  Trash2,
} from 'lucide-react';

interface AdminActiveSessionsProps {
  sessions: SessionWithLocation[];
  onStopSession: (sessionId: string) => Promise<void>;
  onViewLocation: (sessionId: string) => void;
  onViewHistory: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  selectedSessionId?: string | null;
}

export const AdminActiveSessions: React.FC<AdminActiveSessionsProps> = ({
  sessions,
  onStopSession,
  onViewLocation,
  onViewHistory,
  onDeleteSession,
  selectedSessionId,
}) => {
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleStop = async (sessionId: string) => {
    if (!confirm('Are you sure you want to stop this live location sharing session?')) return;

    setStoppingId(sessionId);
    try {
      await onStopSession(sessionId);
    } finally {
      setStoppingId(null);
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!confirm('Delete this session permanently? Its location history will be removed too. This cannot be undone.')) return;

    setDeletingId(sessionId);
    try {
      await onDeleteSession(sessionId);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="bg-[#121215] rounded-2xl border border-[#222226] shadow-xl overflow-hidden font-sans">
      {/* Header */}
      <div className="p-5 border-b border-[#222226] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#18181C] text-[#D1FF26] border border-[#2A2A30] flex items-center justify-center font-bold">
            <Radio className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <h3 className="text-base font-bold uppercase tracking-wider text-white font-mono">
              LIVE VISITOR SESSIONS
            </h3>
            <p className="text-xs text-[#8E8E96] font-mono">
              Active telemetry streams with realtime GPS positioning and device control
            </p>
          </div>
        </div>

        <span className="px-2.5 py-1 rounded-lg bg-[#18181C] text-[#D1FF26] text-xs font-mono font-bold tracking-widest border border-[#2A2A30]">
          {sessions.length} SESSIONS
        </span>
      </div>

      {sessions.length === 0 ? (
        <div className="p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-[#18181C] text-[#D1FF26] border border-[#2A2A30] flex items-center justify-center mx-auto">
            <Activity className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold uppercase tracking-wider text-white font-mono">
            No active visitor sessions
          </h4>
          <p className="text-xs text-[#8E8E96] font-mono max-w-sm mx-auto">
            When a visitor opens a shared link and accepts location consent, their live GPS coordinates will appear here in real-time.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#222226] bg-[#0E0E10] text-[10px] font-mono font-bold text-[#8E8E96] uppercase tracking-widest">
                <th className="py-3 px-4">Visitor &amp; Link</th>
                <th className="py-3 px-4">GPS Coordinates</th>
                <th className="py-3 px-4">Accuracy</th>
                <th className="py-3 px-4">Last Seen</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#222226] text-xs font-mono">
              {sessions.map((session) => {
                const isSelected = selectedSessionId === session.id;
                const loc = session.current_location;
                const lastSeenTime = Math.max(
                  new Date(session.last_seen || session.created_at).getTime(),
                  new Date(session.current_location?.updated_at || session.created_at).getTime()
                );
                const secondsSinceLastSeen = (Date.now() - lastSeenTime) / 1000;
                const isLive = session.status === 'active' && secondsSinceLastSeen <= 15;
                const isDisconnected = session.status === 'stopped_by_visitor' || (session.status === 'active' && !isLive);

                let statusBadge = (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider uppercase bg-[#141810] text-[#D1FF26] border border-[#304018]">
                    🟢 LIVE
                  </span>
                );

                if (session.status === 'stopped_by_admin') {
                  statusBadge = (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider uppercase bg-rose-950/40 text-rose-400 border border-rose-800/50">
                      🔴 STOPPED
                    </span>
                  );
                } else if (session.status === 'permission_denied') {
                  statusBadge = (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider uppercase bg-amber-950/40 text-amber-400 border border-amber-800/50">
                      🟡 DENIED
                    </span>
                  );
                } else if (session.status === 'waiting') {
                  statusBadge = (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider uppercase bg-amber-950/40 text-amber-400 border border-amber-800/50">
                      🟡 INACTIVE
                    </span>
                  );
                } else if (isDisconnected) {
                  statusBadge = (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider uppercase bg-rose-950/40 text-rose-400 border border-rose-800/50">
                      🔴 DISCONNECTED
                    </span>
                  );
                }

                return (
                  <tr
                    key={session.id}
                    className={`hover:bg-[#16161A] transition ${
                      isSelected ? 'bg-[#18181C]' : ''
                    }`}
                  >
                    {/* Visitor & Link */}
                    <td className="py-4 px-4 min-w-[200px]">
                      <div className="space-y-0.5">
                        <div className="font-bold text-white flex items-center gap-1.5 font-mono">
                          <Navigation className="w-3.5 h-3.5 text-[#D1FF26]" />
                          <span>{session.visitor_id}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-[#8E8E96] text-[11px] truncate max-w-[180px] font-sans">
                            {session.video_link?.custom_name || 'Media Session'}
                          </p>
                          {session.video_link?.media_type && (
                            <span className="px-1 py-0.2 rounded text-[8px] font-mono font-bold tracking-widest uppercase bg-[#18181C] text-[#D1FF26] border border-[#2A2A30]">
                              {session.video_link.media_type}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-[#52525B] font-mono">
                          ID: {session.id.substring(0, 8)}...
                        </p>
                      </div>
                    </td>

                    {/* GPS Coordinates */}
                    <td className="py-4 px-4 min-w-[180px]">
                      {loc ? (
                        <div className="space-y-0.5">
                          <div className="font-mono font-medium text-[#F0F0F2]">
                            {formatCoordinates(loc.latitude, loc.longitude, 6)}
                          </div>
                          <a
                            href={getGoogleMapsUrl(loc.latitude, loc.longitude)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={async (e) => {
                              e.preventDefault();
                              const mapWin = window.open('about:blank', '_blank');
                              try {
                                const latest = await db.getLatestLocation(session.id);
                                const lat = latest?.latitude ?? loc.latitude;
                                const lng = latest?.longitude ?? loc.longitude;
                                if (mapWin) {
                                  mapWin.location.href = getGoogleMapsUrl(lat, lng);
                                }
                              } catch (err) {
                                console.warn('Failed to fetch latest location:', err);
                                if (mapWin) {
                                  mapWin.location.href = getGoogleMapsUrl(loc.latitude, loc.longitude);
                                }
                              }
                            }}
                            className="text-[10px] text-[#D1FF26] hover:underline flex items-center gap-1 font-mono uppercase cursor-pointer"
                          >
                            <span>Google Maps</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </div>
                      ) : (
                        <span className="text-[#52525B] italic text-[11px]">
                          Waiting for initial fix...
                        </span>
                      )}
                    </td>

                    {/* Accuracy */}
                    <td className="py-4 px-4 whitespace-nowrap">
                      {loc ? (
                        <span
                          className={`font-semibold ${
                            loc.accuracy && loc.accuracy <= 15
                              ? 'text-[#D1FF26]'
                              : 'text-amber-400'
                          }`}
                        >
                          {formatAccuracy(loc.accuracy)}
                        </span>
                      ) : (
                        <span className="text-[#52525B]">-</span>
                      )}
                    </td>

                    {/* Last Seen */}
                    <td className="py-4 px-4 whitespace-nowrap text-[#8E8E96]">
                      <div className="flex items-center gap-1 text-[11px]">
                        <Clock className="w-3 h-3 text-[#71717A]" />
                        <span>
                          {formatTimestamp(
                            session.current_location?.updated_at ||
                              session.last_seen ||
                              session.created_at
                          )}
                        </span>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="py-4 px-4 whitespace-nowrap">
                      <div className="space-y-1">
                        <div>{statusBadge}</div>
                        {isDisconnected && (
                          <div className="text-[10px] text-rose-400 font-sans">
                            {session.stop_reason || 'Location sharing stopped / Browser connection lost'}
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="py-4 px-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => onViewLocation(session.id)}
                          className="px-2.5 py-1.5 bg-[#18181C] hover:bg-[#222228] text-[#D0D0D5] rounded-xl text-xs font-mono border border-[#2A2A30] flex items-center gap-1 transition"
                          title="Center on Live Map"
                        >
                          <MapPin className="w-3.5 h-3.5 text-[#D1FF26]" />
                          <span>View Map</span>
                        </button>

                        <button
                          onClick={() => onViewHistory(session.id)}
                          className="px-2.5 py-1.5 bg-[#18181C] hover:bg-[#222228] text-[#D0D0D5] rounded-xl text-xs font-mono border border-[#2A2A30] flex items-center gap-1 transition"
                          title="View telemetry breadcrumbs"
                        >
                          <History className="w-3.5 h-3.5 text-[#D1FF26]" />
                          <span>History</span>
                        </button>

                        {isLive && (
                          <button
                            onClick={() => handleStop(session.id)}
                            disabled={stoppingId === session.id}
                            className="px-2.5 py-1.5 bg-rose-950/30 hover:bg-rose-900/50 text-rose-400 rounded-xl text-xs font-mono border border-rose-800/50 flex items-center gap-1 transition"
                            title="End location sharing session"
                          >
                            <StopCircle className="w-3.5 h-3.5 text-rose-400" />
                            <span>{stoppingId === session.id ? 'Stopping...' : 'Stop'}</span>
                          </button>
                        )}

                        <button
                          onClick={() => handleDelete(session.id)}
                          disabled={deletingId === session.id}
                          className="px-2.5 py-1.5 bg-[#18181C] hover:bg-rose-950/40 text-[#8E8E96] hover:text-rose-400 rounded-xl text-xs font-mono border border-[#2A2A30] hover:border-rose-800/50 flex items-center gap-1 transition"
                          title="Delete session and its location history"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>{deletingId === session.id ? 'Deleting...' : 'Delete'}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};