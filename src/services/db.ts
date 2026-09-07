import { getSupabaseClient, getSupabaseConfig } from '../lib/supabase';
import {
  VideoLink,
  VisitorSession,
  LocationUpdate,
  CurrentLocation,
  SessionWithLocation,
  CreateVideoLinkInput,
  SessionStatus,
  GeoLocationPayload,
} from '../types';
import { generateShareId } from '../utils/id';
import { extractYouTubeVideoId } from '../utils/youtube';

// --- Local Reactive Storage Adapter for zero-config offline/preview mode ---
const LOCAL_LINKS_KEY = 'geovideo_local_video_links';
const LOCAL_SESSIONS_KEY = 'geovideo_local_visitor_sessions';
const LOCAL_UPDATES_KEY = 'geovideo_local_location_updates';
const LOCAL_CURRENT_KEY = 'geovideo_local_current_locations';
// Disconnect detection threshold: 5 minutes missing heartbeat = disconnected / stale session
export const STALE_SESSION_THRESHOLD_MS = 5 * 60 * 1000;

// BroadcastChannel for instant cross-tab sync in local mode
const localChannel = typeof window !== 'undefined' && 'BroadcastChannel' in window
  ? new BroadcastChannel('geovideo_realtime_sync')
  : null;

function getLocalData<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function setLocalData<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    if (localChannel) {
      localChannel.postMessage({ type: 'DATA_UPDATED', key, timestamp: Date.now() });
    }
  } catch (e) {
    console.error('Error saving local data:', e);
  }
}

/**
 * Retry helper for transient network/database operations.
 */
async function withRetry<T>(
  operationName: string,
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 800
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      console.warn(`[DB RETRY] ${operationName} failed (attempt ${attempt}/${retries}):`, err?.message || err);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

// Seed initial sample link if empty
function initializeSeedDataIfNeeded() {
  const existing = getLocalData<VideoLink[]>(LOCAL_LINKS_KEY, []);
  if (existing.length === 0) {
    const seedLinks: VideoLink[] = [
      {
        id: 'seed-link-1',
        share_id: '4k8p2a9x',
        custom_name: 'Nature 4K Relaxation - Wildlife in Costa Rica',
        description: 'Experience stunning tropical wildlife and rainforest scenery.',
        media_type: 'youtube',
        youtube_url: 'https://www.youtube.com/watch?v=LXb3EKWsInQ',
        youtube_video_id: 'LXb3EKWsInQ',
        active: true,
        created_at: new Date(Date.now() - 7200000).toISOString(),
      },
      {
        id: 'seed-link-2',
        share_id: 'ph9t7m2k',
        custom_name: '4K Ultra HD Alpine Landscape Photo',
        description: 'High-resolution panorama of the Swiss Alps with atmospheric peaks.',
        media_type: 'photo',
        media_url: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1920&q=80',
        thumbnail_url: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80',
        active: true,
        created_at: new Date(Date.now() - 3600000).toISOString(),
      },
      {
        id: 'seed-link-3',
        share_id: 'vd3w8x1y',
        custom_name: 'Cinematic Ocean Waves Direct Stream',
        description: 'Direct MP4 high-bitrate video stream of ocean tides and coastline.',
        media_type: 'video',
        media_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        thumbnail_url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=400&q=80',
        active: true,
        created_at: new Date(Date.now() - 1800000).toISOString(),
      },
    ];
    setLocalData(LOCAL_LINKS_KEY, seedLinks);
  }
}

initializeSeedDataIfNeeded();

// --- Database Service ---

export const db = {
  /**
   * Video / Media Links
   */
  async getVideoLinks(): Promise<VideoLink[]> {
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('video_links')
          .select('*')
          .order('created_at', { ascending: false });

        if (!error && data) {
          return data as VideoLink[];
        }
        console.warn('[DB] Supabase getVideoLinks error:', error?.message);
      } catch (err: any) {
        console.warn('[DB] Supabase getVideoLinks exception:', err?.message);
      }
    }

    const list = getLocalData<VideoLink[]>(LOCAL_LINKS_KEY, []);
    return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  },

  async getVideoLinkByShareId(shareId: string): Promise<VideoLink | null> {
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('video_links')
          .select('*')
          .eq('share_id', shareId)
          .maybeSingle();

        if (!error && data) {
          return data as VideoLink;
        }
      } catch (err: any) {
        console.warn('[DB] Supabase getVideoLinkByShareId exception:', err?.message);
      }
    }

    const list = getLocalData<VideoLink[]>(LOCAL_LINKS_KEY, []);
    return list.find((link) => link.share_id === shareId && link.active) || null;
  },

  async createVideoLink(input: CreateVideoLinkInput): Promise<VideoLink> {
    const mediaType = input.media_type || 'youtube';
    const shareId = generateShareId(8);
    let newLink: VideoLink;

    if (mediaType === 'youtube') {
      const url = input.youtube_url || '';
      const videoId = extractYouTubeVideoId(url);
      if (!videoId) {
        throw new Error('Invalid YouTube URL. Please provide a valid YouTube video link.');
      }
      newLink = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `link_${Date.now()}`,
        share_id: shareId,
        custom_name: input.custom_name.trim(),
        description: input.description?.trim() || null,
        media_type: 'youtube',
        youtube_url: url.trim(),
        youtube_video_id: videoId,
        active: true,
        created_at: new Date().toISOString(),
      };
    } else if (mediaType === 'photo') {
      const photoUrl = input.media_url || '';
      if (!photoUrl.trim()) {
        throw new Error('Please select an image file or provide a valid image URL.');
      }
      newLink = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `link_${Date.now()}`,
        share_id: shareId,
        custom_name: input.custom_name.trim(),
        description: input.description?.trim() || null,
        media_type: 'photo',
        media_url: photoUrl.trim(),
        thumbnail_url: input.thumbnail_url?.trim() || photoUrl.trim(),
        active: true,
        created_at: new Date().toISOString(),
      };
    } else if (mediaType === 'pdf') {
      const pdfUrl = input.media_url || '';
      if (!pdfUrl.trim()) {
        throw new Error('Please select a PDF file or provide a valid PDF URL.');
      }
      const defaultPdfThumbnail = 'https://images.unsplash.com/photo-1568667256549-094345857637?auto=format&fit=crop&w=1200&q=80';
      newLink = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `link_${Date.now()}`,
        share_id: shareId,
        custom_name: input.custom_name.trim(),
        description: input.description?.trim() || null,
        media_type: 'pdf',
        media_url: pdfUrl.trim(),
        thumbnail_url: input.thumbnail_url?.trim() || defaultPdfThumbnail,
        active: true,
        created_at: new Date().toISOString(),
      };
    } else {
      // mediaType === 'video'
      const videoUrl = input.media_url || '';
      if (!videoUrl.trim()) {
        throw new Error('Please select a video file or provide a valid video stream URL.');
      }
      const defaultVideoThumbnail = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80';
      newLink = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `link_${Date.now()}`,
        share_id: shareId,
        custom_name: input.custom_name.trim(),
        description: input.description?.trim() || null,
        media_type: 'video',
        media_url: videoUrl.trim(),
        thumbnail_url: input.thumbnail_url?.trim() || defaultVideoThumbnail,
        active: true,
        created_at: new Date().toISOString(),
      };
    }

    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('video_links')
          .insert({
            share_id: newLink.share_id,
            custom_name: newLink.custom_name,
            description: newLink.description,
            media_type: newLink.media_type,
            media_url: newLink.media_url,
            thumbnail_url: newLink.thumbnail_url,
            youtube_url: newLink.youtube_url,
            youtube_video_id: newLink.youtube_video_id,
            active: true,
          })
          .select()
          .single();

        if (!error && data) {
          console.log('[DB] Video link created in Supabase:', (data as VideoLink).id);
          return data as VideoLink;
        }
        console.warn('[DB] Supabase createVideoLink failed:', error?.message);
      } catch (err: any) {
        console.warn('[DB] Supabase createVideoLink exception:', err?.message);
      }
    }

    const current = getLocalData<VideoLink[]>(LOCAL_LINKS_KEY, []);
    setLocalData(LOCAL_LINKS_KEY, [newLink, ...current]);
    return newLink;
  },

  async toggleVideoLinkStatus(id: string, active: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        await supabase.from('video_links').update({ active }).eq('id', id);
      } catch (err: any) {
        console.warn('[DB] Supabase toggleVideoLinkStatus exception:', err?.message);
      }
    }

    const current = getLocalData<VideoLink[]>(LOCAL_LINKS_KEY, []);
    const updated = current.map((l) => (l.id === id ? { ...l, active } : l));
    setLocalData(LOCAL_LINKS_KEY, updated);
  },

  async deleteVideoLink(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        await supabase.from('video_links').delete().eq('id', id);
      } catch (err: any) {
        console.warn('[DB] Supabase deleteVideoLink exception:', err?.message);
      }
    }

    const current = getLocalData<VideoLink[]>(LOCAL_LINKS_KEY, []);
    setLocalData(
      LOCAL_LINKS_KEY,
      current.filter((l) => l.id !== id)
    );
  },

  async deleteVisitorSession(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    if (supabase) {
      const { error } = await supabase.from('visitor_sessions').delete().eq('id', id);
      if (error) {
        console.warn('[DB] Supabase deleteVisitorSession error:', error.message);
        throw new Error(`Failed to delete visitor session: ${error.message}`);
      }
    }

    const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
    setLocalData(
      LOCAL_SESSIONS_KEY,
      sessions.filter((s) => s.id !== id)
    );

    const allUpdates = getLocalData<LocationUpdate[]>(LOCAL_UPDATES_KEY, []);
    setLocalData(
      LOCAL_UPDATES_KEY,
      allUpdates.filter((u) => u.session_id !== id)
    );

    const allCurrent = getLocalData<Record<string, CurrentLocation>>(LOCAL_CURRENT_KEY, {});
    delete allCurrent[id];
    setLocalData(LOCAL_CURRENT_KEY, allCurrent);
  },

  /**
   * Visitor Sessions
   */
  async createVisitorSession(
    videoLinkId: string,
    visitorId: string,
    initialStatus: SessionStatus = 'active'
  ): Promise<VisitorSession> {
    const now = new Date().toISOString();

    const supabase = getSupabaseClient();
    if (supabase && initialStatus === 'active') {
      try {
        const { data: existing } = await supabase
          .from('visitor_sessions')
          .select('*')
          .eq('video_link_id', videoLinkId)
          .eq('visitor_id', visitorId)
          .in('status', ['active', 'waiting', 'location_unavailable'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existing) {
          console.log('[DB] Reusing active visitor session:', existing.id);
          const { data: refreshed } = await supabase
            .from('visitor_sessions')
            .update({ status: 'active', last_seen: now })
            .eq('id', existing.id)
            .select()
            .single();
          return (refreshed || existing) as VisitorSession;
        }
      } catch (err: any) {
        console.warn('[DB] Exception checking existing session:', err?.message);
      }
    }

    const newSession: VisitorSession = {
      id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `sess_${Date.now()}`,
      video_link_id: videoLinkId,
      visitor_id: visitorId,
      status: initialStatus,
      consent_given: initialStatus === 'active',
      started_at: now,
      last_seen: now,
      created_at: now,
    };

    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('visitor_sessions')
          .insert({
            video_link_id: videoLinkId,
            visitor_id: visitorId,
            status: initialStatus,
            consent_given: initialStatus === 'active',
            started_at: newSession.started_at,
            last_seen: newSession.last_seen,
          })
          .select()
          .single();

        if (!error && data) {
          console.log('[DB] Created visitor session in Supabase:', (data as VisitorSession).id);
          return data as VisitorSession;
        }
        console.warn('[DB] Supabase createVisitorSession failed:', error?.message);
      } catch (err: any) {
        console.warn('[DB] Supabase createVisitorSession exception:', err?.message);
      }
    }

    const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
    setLocalData(LOCAL_SESSIONS_KEY, [newSession, ...sessions]);
    return newSession;
  },

  async getVisitorSession(sessionId: string): Promise<VisitorSession | null> {
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('visitor_sessions')
          .select('*, video_link:video_links(*)')
          .eq('id', sessionId)
          .maybeSingle();

        if (!error && data) {
          return data as VisitorSession;
        }
      } catch (err: any) {
        console.warn('[DB] Supabase getVisitorSession exception:', err?.message);
      }
    }

    const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return null;

    const links = getLocalData<VideoLink[]>(LOCAL_LINKS_KEY, []);
    const link = links.find((l) => l.id === session.video_link_id);
    return { ...session, video_link: link };
  },

  async updateVisitorSessionStatus(
    sessionId: string,
    status: SessionStatus,
    stopReason?: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const updates: Partial<VisitorSession> = {
      status,
      last_seen: now,
    };

    if (
      status === 'stopped_by_visitor' ||
      status === 'stopped_by_admin' ||
      status === 'permission_denied' ||
      status === 'location_unavailable' ||
      status === 'expired'
    ) {
      updates.stopped_at = now;
      if (stopReason) updates.stop_reason = stopReason;
    }

    console.log(`[DB] Updating session ${sessionId} status to '${status}' (reason: ${stopReason || 'N/A'})`);

    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        await withRetry('updateVisitorSessionStatus', async () => {
          const { error } = await supabase.from('visitor_sessions').update(updates).eq('id', sessionId);
          if (error) throw new Error(error.message);
        });
      } catch (err: any) {
        console.warn(`[DB] Failed to update session ${sessionId} status in Supabase:`, err?.message);
      }
    }

    const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
    const updated = sessions.map((s) => (s.id === sessionId ? { ...s, ...updates } : s));
    setLocalData(LOCAL_SESSIONS_KEY, updated);
  },

  async touchVisitorSession(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    const supabase = getSupabaseClient();
    const allowedStatuses = ['active', 'location_unavailable', 'waiting', 'expired'];

    if (supabase) {
      try {
        await withRetry('touchVisitorSession', async () => {
          const { error } = await supabase
            .from('visitor_sessions')
            .update({ last_seen: now, status: 'active' })
            .eq('id', sessionId)
            .in('status', allowedStatuses);
          if (error) throw new Error(error.message);
        });
        console.log(`[DB HEARTBEAT] Refreshed heartbeat last_seen for session: ${sessionId}`);
      } catch (err: any) {
        console.warn(`[DB HEARTBEAT ERROR] Failed to update heartbeat for session ${sessionId}:`, err?.message);
      }
    }

    const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
    const updated = sessions.map((s) =>
      s.id === sessionId && allowedStatuses.includes(s.status)
        ? { ...s, last_seen: now, status: 'active' }
        : s
    );
    setLocalData(LOCAL_SESSIONS_KEY, updated);
  },

  async expireStaleSessions(): Promise<void> {
    const cutoffMs = Date.now() - STALE_SESSION_THRESHOLD_MS;
    const now = new Date().toISOString();

    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data: activeSessions, error } = await supabase
          .from('visitor_sessions')
          .select('id, last_seen, created_at, current_locations(updated_at)')
          .eq('status', 'active');

        if (!error && activeSessions) {
          const expiredIds: string[] = [];
          for (const s of activeSessions) {
            const sLastSeen = s.last_seen ? new Date(s.last_seen).getTime() : 0;
            const sCreatedAt = s.created_at ? new Date(s.created_at).getTime() : 0;
            const locUpdatedAt =
              s.current_locations && Array.isArray(s.current_locations) && s.current_locations[0]?.updated_at
                ? new Date(s.current_locations[0].updated_at).getTime()
                : s.current_locations && (s.current_locations as any).updated_at
                ? new Date((s.current_locations as any).updated_at).getTime()
                : 0;

            const latestActivityTime = Math.max(sLastSeen, sCreatedAt, locUpdatedAt);
            if (latestActivityTime > 0 && latestActivityTime < cutoffMs) {
              const inactiveSecs = Math.round((Date.now() - latestActivityTime) / 1000);
              console.log(
                `[DB EXPIRY] Stale session detected: session=${s.id}, inactiveFor=${inactiveSecs}s (threshold=${
                  STALE_SESSION_THRESHOLD_MS / 1000
                }s)`
              );
              expiredIds.push(s.id);
            }
          }

          if (expiredIds.length > 0) {
            const { error: updateError } = await supabase
              .from('visitor_sessions')
              .update({
                status: 'expired',
                stopped_at: now,
                stop_reason: 'Session expired after missing location updates and heartbeat',
                last_seen: now,
              })
              .in('id', expiredIds);

            if (updateError) {
              console.warn('[DB EXPIRY] Supabase stale-session cleanup update failed:', updateError.message);
            } else {
              console.log(`[DB EXPIRY] Marked ${expiredIds.length} stale session(s) as expired.`);
            }
          }
        } else if (error) {
          console.warn('[DB EXPIRY] Supabase stale-session query failed:', error.message);
        }
      } catch (err: any) {
        console.warn('[DB EXPIRY] Exception during stale session expiry check:', err?.message);
      }
    }

    // Local storage fallback
    const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
    const currentLocations = getLocalData<Record<string, CurrentLocation>>(LOCAL_CURRENT_KEY, {});
    let changed = false;
    const updated = sessions.map((session) => {
      if (session.status !== 'active') return session;

      const sLastSeen = session.last_seen ? new Date(session.last_seen).getTime() : 0;
      const sCreatedAt = session.created_at ? new Date(session.created_at).getTime() : 0;
      const loc = currentLocations[session.id];
      const locUpdatedAt = loc?.updated_at ? new Date(loc.updated_at).getTime() : 0;

      const latestActivityTime = Math.max(sLastSeen, sCreatedAt, locUpdatedAt);
      if (latestActivityTime > 0 && latestActivityTime < cutoffMs) {
        changed = true;
        console.log(
          `[LOCAL EXPIRY] Stale local session detected: session=${session.id}, inactiveFor=${Math.round(
            (Date.now() - latestActivityTime) / 1000
          )}s`
        );
        return {
          ...session,
          status: 'expired' as SessionStatus,
          stopped_at: now,
          stop_reason: 'Session expired after missing location updates and heartbeat',
          last_seen: now,
        };
      }
      return session;
    });
    if (changed) {
      setLocalData(LOCAL_SESSIONS_KEY, updated);
    }
  },

  /**
   * Location Updates and Current Location
   */
  async updateCurrentLocation(sessionId: string, payload: GeoLocationPayload): Promise<void> {
    const now = new Date().toISOString();
    const currentRecord: CurrentLocation = {
      session_id: sessionId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: payload.accuracy,
      altitude: payload.altitude,
      altitude_accuracy: payload.altitudeAccuracy,
      heading: payload.heading,
      speed: payload.speed,
      updated_at: now,
    };

    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        await withRetry('updateCurrentLocation', async () => {
          const { error } = await supabase
            .from('current_locations')
            .upsert(currentRecord, { onConflict: 'session_id' });
          if (error) throw new Error(error.message);
        });
        console.log(`[DB] Upserted current_locations for session: ${sessionId}`);
      } catch (err: any) {
        console.warn(`[DB ERROR] Failed to upsert current location for session ${sessionId}:`, err?.message);
      }
      await this.touchVisitorSession(sessionId);
      return;
    }

    const allCurrent = getLocalData<Record<string, CurrentLocation>>(LOCAL_CURRENT_KEY, {});
    allCurrent[sessionId] = currentRecord;
    setLocalData(LOCAL_CURRENT_KEY, allCurrent);
    await this.touchVisitorSession(sessionId);
  },

  async recordLocationUpdate(
    sessionId: string,
    payload: GeoLocationPayload
  ): Promise<{ updateId: string }> {
    const now = new Date().toISOString();
    const updateId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `upd_${Date.now()}`;

    const updateRecord: LocationUpdate = {
      id: updateId,
      session_id: sessionId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: payload.accuracy,
      altitude: payload.altitude,
      altitude_accuracy: payload.altitudeAccuracy,
      heading: payload.heading,
      speed: payload.speed,
      created_at: now,
    };

    const currentRecord: CurrentLocation = {
      session_id: sessionId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: payload.accuracy,
      altitude: payload.altitude,
      altitude_accuracy: payload.altitudeAccuracy,
      heading: payload.heading,
      speed: payload.speed,
      updated_at: now,
    };

    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        await withRetry('recordLocationUpdate', async () => {
          // 1. Insert into location_updates
          const { error: insertError } = await supabase.from('location_updates').insert(updateRecord);
          if (insertError) throw new Error(`Insert error: ${insertError.message}`);

          // 2. Upsert into current_locations
          const { error: upsertError } = await supabase
            .from('current_locations')
            .upsert(currentRecord, { onConflict: 'session_id' });
          if (upsertError) throw new Error(`Upsert error: ${upsertError.message}`);

          // 3. Update session last_seen and self-heal status back to 'active'
          const { error: sessionError } = await supabase
            .from('visitor_sessions')
            .update({ last_seen: now, status: 'active' })
            .eq('id', sessionId)
            .in('status', ['active', 'location_unavailable', 'waiting', 'expired']);
          if (sessionError) throw new Error(`Session update error: ${sessionError.message}`);
        });

        console.log(`[DB] Saved location update & refreshed status for session: ${sessionId}`);
        return { updateId };
      } catch (err: any) {
        console.warn(`[DB ERROR] Failed to record location update in Supabase for session ${sessionId}:`, err?.message);
      }
    }

    // Local fallback
    const allUpdates = getLocalData<LocationUpdate[]>(LOCAL_UPDATES_KEY, []);
    setLocalData(LOCAL_UPDATES_KEY, [...allUpdates, updateRecord]);

    const allCurrent = getLocalData<Record<string, CurrentLocation>>(LOCAL_CURRENT_KEY, {});
    allCurrent[sessionId] = currentRecord;
    setLocalData(LOCAL_CURRENT_KEY, allCurrent);

    // Update session last seen and status
    const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
    const allowedStatuses = ['active', 'location_unavailable', 'waiting', 'expired'];
    setLocalData(
      LOCAL_SESSIONS_KEY,
      sessions.map((s) =>
        s.id === sessionId && allowedStatuses.includes(s.status)
          ? { ...s, last_seen: now, status: 'active' }
          : s
      )
    );

    return { updateId };
  },

  async getActiveSessions(): Promise<SessionWithLocation[]> {
    await this.expireStaleSessions();
    const allSessions = await this.getAllSessions();
    return allSessions.filter((s) => s.status === 'active');
  },

  async getAllSessions(): Promise<SessionWithLocation[]> {
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data: sessions, error } = await supabase
          .from('visitor_sessions')
          .select(`
            *,
            video_link:video_links(*),
            current_location:current_locations(*)
          `)
          .order('created_at', { ascending: false });

        if (!error && sessions) {
          return sessions.map((s: any) => ({
            ...s,
            current_location: Array.isArray(s.current_location)
              ? s.current_location[0] || null
              : s.current_location || null,
          })) as SessionWithLocation[];
        }
        console.warn('[DB] Supabase getAllSessions error:', error?.message);
      } catch (err: any) {
        console.warn('[DB] Supabase getAllSessions exception:', err?.message);
      }
    }

    // Local fallback
    const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
    const links = getLocalData<VideoLink[]>(LOCAL_LINKS_KEY, []);
    const currentLocations = getLocalData<Record<string, CurrentLocation>>(LOCAL_CURRENT_KEY, {});
    const updates = getLocalData<LocationUpdate[]>(LOCAL_UPDATES_KEY, []);

    return sessions
      .map((s) => {
        const link = links.find((l) => l.id === s.video_link_id) || null;
        const loc = currentLocations[s.id] || null;
        const count = updates.filter((u) => u.session_id === s.id).length;
        return {
          ...s,
          video_link: link,
          current_location: loc,
          location_count: count,
        };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  },

  async getLocationHistory(sessionId: string): Promise<LocationUpdate[]> {
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('location_updates')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true });

        if (!error && data) {
          return data as LocationUpdate[];
        }
        console.warn('[DB] Supabase getLocationHistory error:', error?.message);
      } catch (err: any) {
        console.warn('[DB] Supabase getLocationHistory exception:', err?.message);
      }
    }

    const updates = getLocalData<LocationUpdate[]>(LOCAL_UPDATES_KEY, []);
    return updates
      .filter((u) => u.session_id === sessionId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  },

  /**
   * Realtime Subscriptions
   */
  subscribeToSession(sessionId: string, onUpdate: (session: VisitorSession) => void): () => void {
    const supabase = getSupabaseClient();

    if (supabase) {
      const channel = supabase
        .channel(`session_${sessionId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'visitor_sessions',
            filter: `id=eq.${sessionId}`,
          },
          (payload) => {
            if (payload.new) {
              onUpdate(payload.new as VisitorSession);
            }
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }

    // Local broadcast channel fallback
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'DATA_UPDATED' && event.data?.key === LOCAL_SESSIONS_KEY) {
        const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
        const target = sessions.find((s) => s.id === sessionId);
        if (target) {
          onUpdate(target);
        }
      }
    };

    if (localChannel) {
      localChannel.addEventListener('message', handler);
    }

    // Also window storage listener for cross-window
    const storageHandler = (e: StorageEvent) => {
      if (e.key === LOCAL_SESSIONS_KEY) {
        const sessions = getLocalData<VisitorSession[]>(LOCAL_SESSIONS_KEY, []);
        const target = sessions.find((s) => s.id === sessionId);
        if (target) {
          onUpdate(target);
        }
      }
    };
    window.addEventListener('storage', storageHandler);

    return () => {
      if (localChannel) {
        localChannel.removeEventListener('message', handler);
      }
      window.removeEventListener('storage', storageHandler);
    };
  },

  subscribeToAllSessions(onUpdate: () => void): () => void {
    const supabase = getSupabaseClient();

    if (supabase) {
      const channel = supabase
        .channel('admin_sessions_channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'visitor_sessions' }, () => {
          onUpdate();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'current_locations' }, () => {
          onUpdate();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'location_updates' }, () => {
          onUpdate();
        })
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }

    // Local broadcast channel fallback
    const handler = () => {
      onUpdate();
    };

    if (localChannel) {
      localChannel.addEventListener('message', handler);
    }
    window.addEventListener('storage', handler);

    return () => {
      if (localChannel) {
        localChannel.removeEventListener('message', handler);
      }
      window.removeEventListener('storage', handler);
    };
  },
};
