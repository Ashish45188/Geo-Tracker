import React, { useState, useEffect, useMemo } from 'react';
import { SessionWithLocation, LocationUpdate } from '../types';
import { db } from '../services/db';
import { SessionRouteDetails } from './SessionRouteDetails';
import {
  downloadSessionCSV,
  downloadSessionJSON,
  downloadCompleteReportCSV,
} from '../services/locationExportService';
import {
  calculateCumulativeDistance,
  formatDistanceInMeters,
  formatDateTime,
  formatTimestamp,
  formatAccuracy,
  getGoogleMapsUrl,
} from '../utils/geo';
import {
  History,
  Search,
  Filter,
  Calendar,
  Eye,
  Download,
  FileText,
  FileJson,
  RotateCcw,
  MapPin,
  Clock,
  Radio,
  CheckCircle2,
  ExternalLink,
  Copy,
  Check,
  Navigation,
} from 'lucide-react';

interface AdminLocationHistoryProps {
  sessions: SessionWithLocation[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  history: LocationUpdate[];
  loadingHistory: boolean;
}

interface SessionStats {
  pointCount: number;
  distanceMeters: number;
  history: LocationUpdate[];
}

export const AdminLocationHistory: React.FC<AdminLocationHistoryProps> = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  history,
  loadingHistory,
}) => {
  // Filter states
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchVisitor, setSearchVisitor] = useState<string>('');

  // Copy coordinates state
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Session route modal state
  const [viewRouteSession, setViewRouteSession] = useState<SessionWithLocation | null>(null);

  // Cached telemetry stats per session (point count and calculated distance)
  const [statsMap, setStatsMap] = useState<Record<string, SessionStats>>({});
  const [loadingStats, setLoadingStats] = useState<boolean>(false);

  const currentSession = sessions.find((s) => s.id === selectedSessionId);

  const handleCopyCoordinates = (id: string, lat: number, lng: number) => {
    const text = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      }).catch(() => {
        fallbackCopyText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      });
    } else {
      fallbackCopyText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const fallbackCopyText = (text: string) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textArea);
  };

  // Best accuracy calculation for selected session history
  const bestAccuracy = history.reduce((min: number | null, item) => {
    if (item.accuracy === null || item.accuracy === undefined) return min;
    if (min === null) return item.accuracy;
    return Math.min(min, item.accuracy);
  }, null as number | null);

  // Load telemetry stats for all sessions so table shows exact distance and point count
  useEffect(() => {
    let isMounted = true;
    async function loadAllSessionStats() {
      setLoadingStats(true);
      try {
        const newMap: Record<string, SessionStats> = {};
        for (const s of sessions) {
          const hist = await db.getLocationHistory(s.id);
          const dist = calculateCumulativeDistance(hist);
          newMap[s.id] = {
            pointCount: hist.length,
            distanceMeters: dist,
            history: hist,
          };
        }
        if (isMounted) {
          setStatsMap(newMap);
        }
      } catch (err) {
        console.error('Failed to load session stats:', err);
      } finally {
        if (isMounted) setLoadingStats(false);
      }
    }

    if (sessions.length > 0) {
      loadAllSessionStats();
    }
  }, [sessions]);

  // Filter sessions based on user inputs
  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      // 1. Visitor ID Search
      if (searchVisitor.trim() !== '') {
        const query = searchVisitor.toLowerCase().trim();
        const visitorMatch = s.visitor_id.toLowerCase().includes(query);
        const linkMatch = s.video_link?.custom_name?.toLowerCase().includes(query) || false;
        if (!visitorMatch && !linkMatch) return false;
      }

      // 2. Status Filter
      if (statusFilter !== 'all') {
        if (statusFilter === 'active' && s.status !== 'active') return false;
        if (statusFilter === 'stopped' && !s.status.startsWith('stopped')) return false;
        if (statusFilter === 'expired' && s.status !== 'expired') return false;
      }

      // 3. Date Range Filter
      const sessionStart = new Date(s.started_at || s.created_at).getTime();

      if (fromDate) {
        const fromTime = new Date(`${fromDate}T00:00:00`).getTime();
        if (sessionStart < fromTime) return false;
      }

      if (toDate) {
        const toTime = new Date(`${toDate}T23:59:59`).getTime();
        if (sessionStart > toTime) return false;
      }

      return true;
    });
  }, [sessions, searchVisitor, statusFilter, fromDate, toDate]);

  const handleClearFilters = () => {
    setFromDate('');
    setToDate('');
    setStatusFilter('all');
    setSearchVisitor('');
  };

  const handleDownloadCSV = (s: SessionWithLocation) => {
    const hist = statsMap[s.id]?.history || [];
    downloadSessionCSV(s, hist);
  };

  const handleDownloadJSON = (s: SessionWithLocation) => {
    const hist = statsMap[s.id]?.history || [];
    downloadSessionJSON(s, hist);
  };

  const handleDownloadReport = (s: SessionWithLocation) => {
    const hist = statsMap[s.id]?.history || [];
    downloadCompleteReportCSV(s, hist);
  };

  return (
    <div className="bg-[#121215] rounded-2xl border border-[#222226] shadow-xl overflow-hidden space-y-6 p-5 font-sans animate-fadeIn">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#222226]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#18181C] text-[#D1FF26] border border-[#2A2A30] flex items-center justify-center font-bold">
            <History className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold uppercase tracking-wider text-white font-mono">
              LOCATION &amp; TRAVEL HISTORY
            </h2>
            <p className="text-xs text-[#8E8E96] font-mono">
              Complete persistent history of visitor location telemetry sessions
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="px-3 py-1.5 rounded-xl bg-[#18181C] border border-[#2A2A30] text-[#D0D0D5]">
            Total Recorded Sessions: <span className="font-bold text-[#D1FF26]">{sessions.length}</span>
          </span>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="bg-[#0A0A0B] p-4 rounded-xl border border-[#222226] space-y-3 font-mono">
        <div className="flex items-center gap-2 text-xs font-bold text-[#8E8E96] uppercase tracking-wider">
          <Filter className="w-3.5 h-3.5 text-[#D1FF26]" />
          <span>Filter Telemetry Logs</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Visitor ID Search */}
          <div>
            <label className="text-[10px] text-[#8E8E96] uppercase tracking-widest block font-bold mb-1">
              Search Visitor / Link
            </label>
            <div className="relative">
              <input
                type="text"
                placeholder="e.g. visitor_123..."
                value={searchVisitor}
                onChange={(e) => setSearchVisitor(e.target.value)}
                className="w-full bg-[#121215] border border-[#2A2A30] rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-[#52525B] focus:outline-none focus:border-[#D1FF26]"
              />
              <Search className="w-3.5 h-3.5 text-[#71717A] absolute left-2.5 top-2.5" />
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <label className="text-[10px] text-[#8E8E96] uppercase tracking-widest block font-bold mb-1">
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full bg-[#121215] border border-[#2A2A30] rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#D1FF26]"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active Tracking (LIVE)</option>
              <option value="stopped">Stopped by Visitor/Admin</option>
              <option value="expired">Expired / Offline</option>
            </select>
          </div>

          {/* From Date */}
          <div>
            <label className="text-[10px] text-[#8E8E96] uppercase tracking-widest block font-bold mb-1">
              From Date
            </label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full bg-[#121215] border border-[#2A2A30] rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#D1FF26]"
            />
          </div>

          {/* To Date */}
          <div>
            <label className="text-[10px] text-[#8E8E96] uppercase tracking-widest block font-bold mb-1">
              To Date
            </label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full bg-[#121215] border border-[#2A2A30] rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#D1FF26]"
            />
          </div>
        </div>

        {/* Clear Filters Button */}
        {(fromDate || toDate || statusFilter !== 'all' || searchVisitor) && (
          <div className="flex justify-end pt-2 border-t border-[#1E1E22]">
            <button
              onClick={handleClearFilters}
              className="px-3 py-1 bg-[#18181C] hover:bg-[#222228] text-[#D0D0D5] rounded-lg text-xs font-mono font-bold border border-[#2A2A30] flex items-center gap-1.5 transition"
            >
              <RotateCcw className="w-3 h-3 text-[#D1FF26]" />
              <span>Clear Filters</span>
            </button>
          </div>
        )}
      </div>

      {/* Main Location History Table */}
      <div className="overflow-x-auto rounded-xl border border-[#222226]">
        <table className="w-full text-left border-collapse">
          <thead className="bg-[#0E0E10] border-b border-[#222226] text-[10px] font-mono font-bold text-[#8E8E96] uppercase tracking-widest">
            <tr>
              <th className="py-3 px-4">Visitor ID</th>
              <th className="py-3 px-4">Session ID</th>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 px-4">Started At</th>
              <th className="py-3 px-4">Stopped At</th>
              <th className="py-3 px-4">Last Seen</th>
              <th className="py-3 px-4 text-center">Location Points</th>
              <th className="py-3 px-4">Distance Travelled</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#222226] text-xs font-mono">
            {filteredSessions.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-[#71717A] text-xs font-mono">
                  NO LOCATION SESSIONS MATCHING YOUR FILTER CRITERIA.
                </td>
              </tr>
            ) : (
              filteredSessions.map((s) => {
                const isActive = s.status === 'active';
                const isSelected = selectedSessionId === s.id;
                const sessionStats = statsMap[s.id] || { pointCount: s.location_count || 0, distanceMeters: 0, history: [] };

                return (
                  <tr
                    key={s.id}
                    onClick={() => onSelectSession(s.id)}
                    className={`hover:bg-[#16161A] transition cursor-pointer ${
                      isSelected ? 'bg-[#18181C] border-l-2 border-[#D1FF26]' : ''
                    }`}
                  >
                    {/* Visitor ID */}
                    <td className="py-3 px-4 font-bold text-white whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[#D1FF26]">&bull;</span>
                        <span>{s.visitor_id}</span>
                      </div>
                      <div className="text-[10px] text-[#8E8E96] font-normal truncate max-w-[150px]">
                        {s.video_link?.custom_name || 'Direct Link'}
                      </div>
                    </td>

                    {/* Session ID */}
                    <td className="py-3 px-4 text-[#8E8E96] font-mono text-[11px] whitespace-nowrap">
                      {s.id.slice(0, 8)}...
                    </td>

                    {/* Status Badge */}
                    <td className="py-3 px-4 whitespace-nowrap">
                      {isActive ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-[#141810] text-[#D1FF26] border border-[#304018]">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#D1FF26] animate-pulse"></span>
                          ● LIVE
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-[#1A1A20] text-[#8E8E96] border border-[#2A2A30]">
                          COMPLETED
                        </span>
                      )}
                    </td>

                    {/* Started At */}
                    <td className="py-3 px-4 text-[#D0D0D5] whitespace-nowrap">
                      {formatDateTime(s.started_at || s.created_at)}
                    </td>

                    {/* Stopped At */}
                    <td className="py-3 px-4 text-[#8E8E96] whitespace-nowrap">
                      {s.stopped_at ? formatDateTime(s.stopped_at) : isActive ? '--' : 'N/A'}
                    </td>

                    {/* Last Seen */}
                    <td className="py-3 px-4 text-[#8E8E96] whitespace-nowrap">
                      {s.last_seen ? formatTimestamp(s.last_seen) : 'N/A'}
                    </td>

                    {/* Location Points */}
                    <td className="py-3 px-4 text-center text-white font-bold whitespace-nowrap">
                      {sessionStats.pointCount}
                    </td>

                    {/* Distance Travelled */}
                    <td className="py-3 px-4 font-bold text-[#D1FF26] whitespace-nowrap">
                      {formatDistanceInMeters(sessionStats.distanceMeters)}
                    </td>

                    {/* Actions */}
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => {
                            onSelectSession(s.id);
                            setViewRouteSession(s);
                          }}
                          className="px-2.5 py-1 bg-[#D1FF26] hover:bg-[#bfe822] text-black font-bold rounded-lg text-[11px] uppercase tracking-wider flex items-center gap-1 transition cursor-pointer"
                          title="View complete road route on map"
                        >
                          <Eye className="w-3 h-3 text-black stroke-[2.5]" />
                          <span>View Route</span>
                        </button>

                        <button
                          onClick={() => handleDownloadCSV(s)}
                          className="p-1.5 bg-[#18181C] hover:bg-[#222228] text-white rounded-lg border border-[#2A2A30] transition cursor-pointer"
                          title="Download CSV"
                        >
                          <FileText className="w-3.5 h-3.5 text-[#D1FF26]" />
                        </button>

                        <button
                          onClick={() => handleDownloadJSON(s)}
                          className="p-1.5 bg-[#18181C] hover:bg-[#222228] text-white rounded-lg border border-[#2A2A30] transition cursor-pointer"
                          title="Download JSON"
                        >
                          <FileJson className="w-3.5 h-3.5 text-[#D1FF26]" />
                        </button>

                        <button
                          onClick={() => handleDownloadReport(s)}
                          className="p-1.5 bg-[#18181C] hover:bg-[#222228] text-white rounded-lg border border-[#2A2A30] transition cursor-pointer"
                          title="Download Complete Session Report"
                        >
                          <Download className="w-3.5 h-3.5 text-white" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Selected Session Telemetry & Coordinates Table (Stashed Feature) */}
      <div className="bg-[#0A0A0B] rounded-2xl border border-[#222226] p-5 space-y-4 font-sans">
        {/* Header & Session Selector */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#222226]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#18181C] text-[#D1FF26] border border-[#2A2A30] flex items-center justify-center font-bold">
              <Navigation className="w-4 h-4 text-[#D1FF26]" />
            </div>
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wider text-white font-mono flex items-center gap-2">
                <span>SESSION TELEMETRY &amp; COORDINATES</span>
                {currentSession && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#141810] text-[#D1FF26] border border-[#304018] uppercase">
                    {currentSession.visitor_id}
                  </span>
                )}
              </h3>
              <p className="text-xs text-[#8E8E96] font-mono">
                Chronological GPS breadcrumbs, speed, and accuracy records with 6-decimal precision
              </p>
            </div>
          </div>

          {/* Dropdown Selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-mono font-bold text-[#8E8E96] uppercase tracking-wider">
              Session:
            </label>
            <select
              value={selectedSessionId || ''}
              onChange={(e) => onSelectSession(e.target.value)}
              className="bg-[#121215] border border-[#2A2A30] rounded-xl px-3 py-1.5 text-xs text-[#F0F0F2] focus:outline-none focus:border-[#D1FF26] font-mono"
            >
              <option value="" disabled>
                -- Select a Visitor Session --
              </option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.visitor_id} - {s.video_link?.custom_name || 'Direct Link'} ({s.status.toUpperCase()})
                </option>
              ))}
            </select>
          </div>
        </div>

        {!selectedSessionId ? (
          <div className="p-10 text-center text-[#71717A] text-xs font-mono">
            PLEASE SELECT A VISITOR SESSION ABOVE OR FROM THE TABLE TO INSPECT ITS RECORDED LOCATION TELEMETRY.
          </div>
        ) : loadingHistory ? (
          <div className="p-10 text-center space-y-2">
            <div className="w-8 h-8 border-2 border-[#D1FF26] border-t-transparent rounded-full animate-spin mx-auto"></div>
            <p className="text-xs text-[#8E8E96] font-mono">LOADING TELEMETRY HISTORY...</p>
          </div>
        ) : history.length === 0 ? (
          <div className="p-10 text-center text-[#71717A] text-xs font-mono">
            NO LOCATION UPDATES RECORDED FOR THIS SESSION YET.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary Stats Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[#121215] p-3.5 rounded-xl border border-[#222226] text-xs font-mono">
              <div>
                <span className="text-[10px] text-[#8E8E96] uppercase tracking-widest block font-bold">
                  Total Updates
                </span>
                <span className="font-bold text-white font-mono text-sm">{history.length}</span>
              </div>
              <div>
                <span className="text-[10px] text-[#8E8E96] uppercase tracking-widest block font-bold">
                  Best GPS Accuracy
                </span>
                <span className="font-bold text-[#D1FF26] text-sm">
                  {bestAccuracy !== null ? formatAccuracy(bestAccuracy) : 'N/A'}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-[#8E8E96] uppercase tracking-widest block font-bold">
                  Started At
                </span>
                <span className="font-medium text-[#D0D0D5] text-xs">
                  {formatDateTime(history[0].created_at)}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-[#8E8E96] uppercase tracking-widest block font-bold">
                  Latest Fix
                </span>
                <span className="font-medium text-[#D0D0D5] text-xs">
                  {formatTimestamp(history[history.length - 1].created_at)}
                </span>
              </div>
            </div>

            {/* Telemetry Table */}
            <div className="overflow-x-auto max-h-96 overflow-y-auto rounded-xl border border-[#222226]">
              <table className="w-full text-left border-collapse min-w-[750px]">
                <thead className="sticky top-0 bg-[#0E0E10] border-b border-[#222226] text-[10px] font-mono font-bold text-[#8E8E96] uppercase tracking-widest z-10">
                  <tr>
                    <th className="py-2.5 px-3">#</th>
                    <th className="py-2.5 px-3">Timestamp</th>
                    <th className="py-2.5 px-3">Latitude</th>
                    <th className="py-2.5 px-3">Longitude</th>
                    <th className="py-2.5 px-3">Accuracy</th>
                    <th className="py-2.5 px-3">Speed</th>
                    <th className="py-2.5 px-3">Altitude</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#222226] text-xs font-mono">
                  {history.map((record, index) => (
                    <tr key={record.id} className="hover:bg-[#16161A] transition">
                      <td className="py-2.5 px-3 text-[#71717A] text-[11px]">{index + 1}</td>
                      <td className="py-2.5 px-3 text-[#D0D0D5] whitespace-nowrap">
                        {formatTimestamp(record.created_at)}
                      </td>
                      <td className="py-2.5 px-3 text-white font-semibold whitespace-nowrap">
                        {record.latitude.toFixed(6)}
                      </td>
                      <td className="py-2.5 px-3 text-white font-semibold whitespace-nowrap">
                        {record.longitude.toFixed(6)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`${
                            record.accuracy && record.accuracy <= 15
                              ? 'text-[#D1FF26] font-semibold'
                              : 'text-amber-400'
                          }`}
                        >
                          {formatAccuracy(record.accuracy)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-[#8E8E96] whitespace-nowrap">
                        {record.speed !== null && record.speed !== undefined
                          ? `${(record.speed * 3.6).toFixed(1)} km/h`
                          : '-'}
                      </td>
                      <td className="py-2.5 px-3 text-[#8E8E96] whitespace-nowrap">
                        {record.altitude !== null && record.altitude !== undefined
                          ? `${record.altitude.toFixed(1)}m`
                          : '-'}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleCopyCoordinates(record.id, record.latitude, record.longitude)}
                            className="px-2.5 py-1 bg-[#18181C] hover:bg-[#222228] text-[#D0D0D5] hover:text-white rounded-lg border border-[#2A2A30] flex items-center gap-1 text-[11px] font-mono transition cursor-pointer"
                            title="Copy Latitude & Longitude"
                          >
                            {copiedId === record.id ? (
                              <>
                                <Check className="w-3 h-3 text-[#D1FF26]" />
                                <span className="text-[#D1FF26]">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3 text-[#8E8E96]" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                          <a
                            href={getGoogleMapsUrl(record.latitude, record.longitude)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2.5 py-1 bg-[#18181C] hover:bg-[#222228] text-[#D1FF26] hover:bg-[#D1FF26]/10 rounded-lg border border-[#2A2A30] flex items-center gap-1 text-[11px] font-mono transition uppercase font-semibold"
                            title="Open in Google Maps"
                          >
                            <span>Open in Google Maps</span>
                            <ExternalLink className="w-3 h-3 text-[#D1FF26]" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Detail Route Modal */}
      {viewRouteSession && (
        <SessionRouteDetails
          session={viewRouteSession}
          onClose={() => setViewRouteSession(null)}
        />
      )}
    </div>
  );
};
