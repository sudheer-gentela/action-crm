/**
 * MeetingTranscriptPanel.js
 * frontend/src/MeetingTranscriptPanel.js
 *
 * Renders inside the CalendarView meeting-detail-panel as a new section.
 * Shows transcript status, AI analysis results, and attendee attendance
 * with inline override controls.
 *
 * Props:
 *   meeting     — the selectedMeeting object from CalendarView state
 *   contacts    — full contacts array from CalendarView (for name lookup)
 *   onRefresh   — callback to re-fetch the meeting list after changes
 */

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL;

// ── Attendance status config ──────────────────────────────────────────────────
const STATUS_CONFIG = {
  invited:  { label: 'Invited',  color: '#6b7280', bg: '#f3f4f6', icon: '📅' },
  attended: { label: 'Attended', color: '#065f46', bg: '#d1fae5', icon: '✅' },
  no_show:  { label: 'No show',  color: '#991b1b', bg: '#fee2e2', icon: '❌' },
  unknown:  { label: 'Unknown',  color: '#92400e', bg: '#fef3c7', icon: '❓' },
};

const STATUS_OPTIONS = ['invited', 'attended', 'no_show', 'unknown'];

// ── Analysis section config ───────────────────────────────────────────────────
const HEALTH_CONFIG = {
  healthy: { color: '#065f46', bg: '#d1fae5', label: 'Healthy' },
  watch:   { color: '#92400e', bg: '#fef3c7', label: 'Watch'   },
  risk:    { color: '#991b1b', bg: '#fee2e2', label: 'At Risk'  },
};

export default function MeetingTranscriptPanel({ meeting, contacts, onRefresh }) {
  const [transcript,    setTranscript]    = useState(null);
  const [attendees,     setAttendees]     = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [uploadMode,    setUploadMode]    = useState(false);
  const [uploadText,    setUploadText]    = useState('');
  const [uploading,     setUploading]     = useState(false);
  const [uploadError,   setUploadError]   = useState('');
  const [savingStatus,  setSavingStatus]  = useState(null); // contactId being saved
  const [analysisOpen,  setAnalysisOpen]  = useState(false);
  const [gmeetFetching, setGmeetFetching] = useState(false);
  const [gmeetError,    setGmeetError]    = useState('');

  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── Load transcript + attendees ───────────────────────────────
  const load = useCallback(async () => {
    if (!meeting?.id) return;
    setLoading(true);
    setError('');

    try {
      // Fetch transcript linked to this meeting (if any)
      const tRes = await fetch(
        `${API}/transcripts?meetingId=${meeting.id}`,
        { headers }
      );
      const tData = await tRes.json();
      const transcripts = tData.transcripts || [];
      // Use the most recent transcript for this meeting
      setTranscript(transcripts[0] || null);

      // Fetch attendees with attendance_status for this meeting
      const aRes = await fetch(
        `${API}/meetings/${meeting.id}/attendees`,
        { headers }
      );
      if (aRes.ok) {
        const aData = await aRes.json();
        setAttendees(aData.attendees || []);
      } else {
        // Fall back to contacts-based list if new endpoint not yet deployed
        const legacyAttendees = (meeting.attendees || [])
          .map(id => {
            const c = contacts.find(c => c.id === id);
            return c ? { contact_id: id, name: `${c.first_name} ${c.last_name}`, email: c.email, title: c.title, attendance_status: 'unknown', source: 'calendar' } : null;
          })
          .filter(Boolean);
        setAttendees(legacyAttendees);
      }
    } catch (err) {
      setError('Failed to load transcript data');
    } finally {
      setLoading(false);
    }
  }, [meeting?.id]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  // ── Upload transcript ─────────────────────────────────────────
  const handleUpload = async () => {
    if (!uploadText.trim() || uploadText.trim().length < 50) {
      setUploadError('Transcript must be at least 50 characters');
      return;
    }

    setUploading(true);
    setUploadError('');

    try {
      const res = await fetch(`${API}/transcripts/upload`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text:      uploadText.trim(),
          meetingId: meeting.id,
          dealId:    meeting.deal_id || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Upload failed');

      setUploadText('');
      setUploadMode(false);
      // Poll briefly then reload to show analysis status
      setTimeout(() => load(), 2000);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  };

  // ── Inline attendance status update ──────────────────────────
  const handleStatusChange = async (att, newStatus) => {
    const personId   = att.contact_id || att.prospect_id;
    const personType = att.person_type || (att.contact_id ? 'contact' : 'prospect');

    setSavingStatus(personId);

    // Optimistic update
    setAttendees(prev =>
      prev.map(a => (a.contact_id || a.prospect_id) === personId
        ? { ...a, attendance_status: newStatus, source: 'manual' }
        : a
      )
    );

    try {
      await fetch(
        `${API}/meetings/${meeting.id}/attendees/${personId}?type=${personType}`,
        {
          method:  'PATCH',
          headers,
          body:    JSON.stringify({ attendance_status: newStatus }),
        }
      );
    } catch (err) {
      load();
    } finally {
      setSavingStatus(null);
    }
  };

  // ── Re-trigger analysis ───────────────────────────────────────
  const handleReanalyze = async () => {
    if (!transcript?.id) return;
    try {
      await fetch(`${API}/transcripts/${transcript.id}/analyze`, {
        method: 'POST', headers
      });
      setTimeout(() => load(), 1500);
    } catch (err) {
      setError('Failed to start re-analysis');
    }
  };

  // ── Fetch Google Meet transcript from Drive ───────────────────
  const handleGmeetFetch = async () => {
    setGmeetFetching(true);
    setGmeetError('');

    try {
      const res  = await fetch(`${API}/meetings/${meeting.id}/gmeet-transcript`, { headers });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to fetch transcript');
      }

      if (!data.found) {
        setGmeetError(data.message || 'No transcript found in Drive for this meeting.');
        return;
      }

      // Transcript stored + analysis triggered — reload after brief delay
      setTimeout(() => load(), 1500);
    } catch (err) {
      setGmeetError(err.message);
    } finally {
      setGmeetFetching(false);
    }
  };

  if (loading) {
    return (
      <div style={S.section}>
        <h3 style={S.sectionTitle}>🎙️ Transcript & Analysis</h3>
        <div style={S.loading}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={S.section}>
      <h3 style={S.sectionTitle}>🎙️ Transcript & Analysis</h3>

      {error && <div style={S.errorBox}>{error}</div>}

      {/* ── Attendees with attendance status ─────────────────── */}
      {attendees.length > 0 && (
        <div style={S.subsection}>
          <div style={S.subsectionTitle}>Attendees</div>
          {attendees.map(att => {
            const personId  = att.contact_id || att.prospect_id;
            const cfg       = STATUS_CONFIG[att.attendance_status] || STATUS_CONFIG.unknown;
            const isSaving  = savingStatus === personId;
            return (
              <div key={personId} style={S.attendeeRow}>
                <div style={S.attendeeInfo}>
                  <span style={S.attendeeIcon}>{att.person_type === 'prospect' ? '🎯' : '👤'}</span>
                  <div>
                    <div style={S.attendeeName}>{att.name}</div>
                    {att.title && <div style={S.attendeeMeta}>
                      {att.title}
                      {att.person_type === 'prospect' && <span style={{ color: '#6366f1', marginLeft: 4, fontSize: 10, fontWeight: 600 }}>PROSPECT</span>}
                    </div>}
                  </div>
                </div>
                <div style={S.attendeeRight}>
                  {att.source === 'manual' && (
                    <span style={S.manualBadge} title="Manually set">✎</span>
                  )}
                  <select
                    value={att.attendance_status || 'unknown'}
                    onChange={e => handleStatusChange(att, e.target.value)}
                    disabled={isSaving}
                    style={{
                      ...S.statusSelect,
                      background: cfg.bg,
                      color:      cfg.color,
                      opacity:    isSaving ? 0.6 : 1,
                    }}
                  >
                    {STATUS_OPTIONS.map(opt => (
                      <option key={opt} value={opt}>
                        {STATUS_CONFIG[opt].icon} {STATUS_CONFIG[opt].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Transcript status ─────────────────────────────────── */}
      {!transcript ? (
        <div style={S.subsection}>
          <div style={S.noTranscript}>
            <div style={S.noTranscriptText}>No transcript yet</div>
            <div style={S.noTranscriptSub}>
              Transcripts arrive automatically via Zoom, Teams, or Fireflies webhooks.
              You can also paste one manually.
            </div>
            {!uploadMode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                <button style={S.btnOutline} onClick={() => setUploadMode(true)}>
                  + Paste transcript
                </button>
                <button
                  style={{
                    ...S.btnOutline,
                    display:     'flex',
                    alignItems:  'center',
                    gap:         6,
                    opacity:     gmeetFetching ? 0.6 : 1,
                    borderColor: '#4285f4',
                    color:       '#4285f4',
                  }}
                  onClick={handleGmeetFetch}
                  disabled={gmeetFetching}
                  title="Search your Google Drive for a transcript doc saved by Google Meet"
                >
                  {gmeetFetching ? (
                    <>⏳ Fetching from Drive…</>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                        <path d="M6 2h9l5 5v15a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" stroke="#4285f4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <polyline points="14,2 14,8 20,8" stroke="#4285f4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Fetch from Google Drive
                    </>
                  )}
                </button>
                {gmeetError && (
                  <div style={{ fontSize: 12, color: '#dc2626', maxWidth: 320, lineHeight: 1.4 }}>
                    ⚠️ {gmeetError}
                  </div>
                )}
              </div>
            ) : (
              <div style={S.uploadBox}>
                <textarea
                  value={uploadText}
                  onChange={e => setUploadText(e.target.value)}
                  placeholder="Paste transcript text here… (minimum 50 characters)"
                  rows={6}
                  style={S.textarea}
                />
                {uploadError && <div style={S.uploadError}>{uploadError}</div>}
                <div style={S.uploadActions}>
                  <button
                    style={{ ...S.btnPrimary, opacity: uploading ? 0.6 : 1 }}
                    onClick={handleUpload}
                    disabled={uploading}
                  >
                    {uploading ? 'Uploading…' : 'Upload & Analyse'}
                  </button>
                  <button
                    style={S.btnSecondary}
                    onClick={() => { setUploadMode(false); setUploadText(''); setUploadError(''); }}
                    disabled={uploading}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={S.subsection}>
          {/* Status bar */}
          <div style={S.statusBar}>
            <div style={S.statusLeft}>
              <StatusDot status={transcript.analysis_status} />
              <span style={S.statusText}>
                {transcript.analysis_status === 'completed' ? 'Analysis complete' :
                 transcript.analysis_status === 'analyzing' ? 'Analysing…' :
                 transcript.analysis_status === 'failed'    ? 'Analysis failed' :
                 'Pending analysis'}
              </span>
            </div>
            <div style={S.statusRight}>
              <span style={S.transcriptMeta}>
                via {transcript.source?.replace('_', ' ')} ·{' '}
                {new Date(transcript.created_at).toLocaleDateString()}
              </span>
              {transcript.analysis_status === 'completed' && (
                <button style={S.btnTiny} onClick={handleReanalyze}>Re-analyse</button>
              )}
              {transcript.analysis_status === 'failed' && (
                <button style={S.btnTiny} onClick={handleReanalyze}>Retry</button>
              )}
            </div>
          </div>

          {/* Analysis results */}
          {transcript.analysis_status === 'completed' && transcript.analysis_result && (
            <AnalysisResults
              analysis={transcript.analysis_result}
              open={analysisOpen}
              onToggle={() => setAnalysisOpen(o => !o)}
            />
          )}

          {transcript.analysis_status === 'analyzing' && (
            <div style={S.analyzingBox}>
              ⏳ AI analysis in progress — check back in a moment
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── StatusDot ─────────────────────────────────────────────────────────────────
function StatusDot({ status }) {
  const colors = {
    completed: '#059669',
    analyzing: '#d97706',
    failed:    '#dc2626',
    pending:   '#9ca3af',
  };
  return (
    <span style={{
      display:      'inline-block',
      width:        8,
      height:       8,
      borderRadius: '50%',
      background:   colors[status] || colors.pending,
      marginRight:  6,
      flexShrink:   0,
    }} />
  );
}

// ── AnalysisResults ───────────────────────────────────────────────────────────
function AnalysisResults({ analysis, open, onToggle }) {
  const healthCfg = HEALTH_CONFIG[analysis.dealHealthSignals?.overallHealth];

  return (
    <div style={S.analysisWrap}>
      {/* Summary — always visible */}
      {analysis.summary && (
        <div style={S.summary}>{analysis.summary}</div>
      )}

      {/* Deal health badge */}
      {healthCfg && (
        <div style={{ ...S.healthBadge, background: healthCfg.bg, color: healthCfg.color }}>
          Deal health: {healthCfg.label}
          {analysis.dealHealthSignals?.reasoning && (
            <span style={S.healthReason}> — {analysis.dealHealthSignals.reasoning}</span>
          )}
        </div>
      )}

      {/* Expand / collapse for detail */}
      <button style={S.expandBtn} onClick={onToggle}>
        {open ? '▾ Hide details' : '▸ Show details'}
      </button>

      {open && (
        <div style={S.analysisDetail}>
          {/* Action items */}
          {analysis.actionItems?.length > 0 && (
            <AnalysisSection title="Action items" icon="⚡">
              {analysis.actionItems.map((item, i) => (
                <div key={i} style={S.listItem}>
                  <PriorityDot priority={item.priority} />
                  <div>
                    <div style={S.listItemText}>{item.description}</div>
                    <div style={S.listItemMeta}>
                      {item.owner === 'us' ? 'Our team' : 'Customer'}
                      {item.dueDate && ` · Due ${item.dueDate}`}
                    </div>
                  </div>
                </div>
              ))}
            </AnalysisSection>
          )}

          {/* Concerns */}
          {analysis.concerns?.length > 0 && (
            <AnalysisSection title="Concerns raised" icon="⚠️">
              {analysis.concerns.map((c, i) => (
                <div key={i} style={S.listItem}>
                  <SeverityDot severity={c.severity} />
                  <div>
                    <div style={S.listItemText}>{c.concern}</div>
                    <div style={S.listItemMeta}>
                      {c.severity} severity · {c.addressed ? 'Addressed' : 'Unresolved'}
                    </div>
                  </div>
                </div>
              ))}
            </AnalysisSection>
          )}

          {/* Commitments */}
          {(analysis.commitments?.us?.length > 0 || analysis.commitments?.customer?.length > 0) && (
            <AnalysisSection title="Commitments" icon="🤝">
              {analysis.commitments?.us?.map((c, i) => (
                <div key={`us-${i}`} style={S.listItem}>
                  <span style={S.commitOwner}>Us</span>
                  <div style={S.listItemText}>{c}</div>
                </div>
              ))}
              {analysis.commitments?.customer?.map((c, i) => (
                <div key={`cust-${i}`} style={S.listItem}>
                  <span style={{ ...S.commitOwner, background: '#dbeafe', color: '#1d4ed8' }}>Them</span>
                  <div style={S.listItemText}>{c}</div>
                </div>
              ))}
            </AnalysisSection>
          )}

          {/* Key points */}
          {analysis.keyPoints?.length > 0 && (
            <AnalysisSection title="Key points" icon="📌">
              {analysis.keyPoints.map((pt, i) => (
                <div key={i} style={{ ...S.listItem, alignItems: 'flex-start' }}>
                  <span style={S.bullet}>·</span>
                  <div style={S.listItemText}>{pt}</div>
                </div>
              ))}
            </AnalysisSection>
          )}

          {/* Next steps */}
          {analysis.nextSteps?.length > 0 && (
            <AnalysisSection title="Next steps" icon="→">
              {analysis.nextSteps.map((step, i) => (
                <div key={i} style={{ ...S.listItem, alignItems: 'flex-start' }}>
                  <span style={S.stepNum}>{i + 1}</span>
                  <div style={S.listItemText}>{step}</div>
                </div>
              ))}
            </AnalysisSection>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small sub-components ──────────────────────────────────────────────────────
function AnalysisSection({ title, icon, children }) {
  return (
    <div style={S.analysisSection}>
      <div style={S.analysisSectionTitle}>{icon} {title}</div>
      {children}
    </div>
  );
}

function PriorityDot({ priority }) {
  const colors = { high: '#dc2626', medium: '#d97706', low: '#059669' };
  return <span style={{ ...S.dot, background: colors[priority] || '#9ca3af' }} />;
}

function SeverityDot({ severity }) {
  const colors = { high: '#dc2626', medium: '#d97706', low: '#059669' };
  return <span style={{ ...S.dot, background: colors[severity] || '#9ca3af' }} />;
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  section:          { borderTop: '1px solid #f3f4f6', paddingTop: 16, marginTop: 4 },
  sectionTitle:     { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12, marginTop: 0 },
  subsection:       { marginBottom: 14 },
  subsectionTitle:  { fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 },
  loading:          { fontSize: 13, color: '#9ca3af', padding: '8px 0' },
  errorBox:         { padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 13, color: '#dc2626', marginBottom: 12 },

  // Attendee row
  attendeeRow:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f9fafb' },
  attendeeInfo:     { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  attendeeIcon:     { fontSize: 14, flexShrink: 0 },
  attendeeName:     { fontSize: 13, fontWeight: 500, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  attendeeMeta:     { fontSize: 11, color: '#9ca3af' },
  attendeeRight:    { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  manualBadge:      { fontSize: 10, color: '#9ca3af', title: 'Manually set' },
  statusSelect:     { fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 10, padding: '3px 8px', cursor: 'pointer', outline: 'none' },

  // No transcript
  noTranscript:     { padding: '14px 0' },
  noTranscriptText: { fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 4 },
  noTranscriptSub:  { fontSize: 12, color: '#9ca3af', lineHeight: 1.5, marginBottom: 10 },

  // Upload
  uploadBox:        { marginTop: 10 },
  textarea:         { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 12, fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box', color: '#374151' },
  uploadActions:    { display: 'flex', gap: 8, marginTop: 8 },
  uploadError:      { fontSize: 12, color: '#dc2626', marginTop: 4 },

  // Status bar
  statusBar:        { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  statusLeft:       { display: 'flex', alignItems: 'center' },
  statusText:       { fontSize: 13, fontWeight: 500, color: '#374151' },
  statusRight:      { display: 'flex', alignItems: 'center', gap: 8 },
  transcriptMeta:   { fontSize: 11, color: '#9ca3af' },

  analyzingBox:     { padding: '10px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7, fontSize: 13, color: '#92400e' },

  // Analysis
  analysisWrap:     { marginTop: 4 },
  summary:          { fontSize: 13, color: '#374151', lineHeight: 1.6, marginBottom: 8, padding: '10px 12px', background: '#f8fafc', borderRadius: 7 },
  healthBadge:      { display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, marginBottom: 8 },
  healthReason:     { fontWeight: 400, fontSize: 11 },
  expandBtn:        { background: 'none', border: 'none', fontSize: 12, color: '#6366f1', cursor: 'pointer', padding: '4px 0', fontWeight: 500 },
  analysisDetail:   { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 },
  analysisSection:  { background: '#f8fafc', borderRadius: 7, padding: '10px 12px' },
  analysisSectionTitle: { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 },
  listItem:         { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 },
  listItemText:     { color: '#374151', lineHeight: 1.4, flex: 1 },
  listItemMeta:     { fontSize: 11, color: '#9ca3af', marginTop: 1 },
  dot:              { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  bullet:           { color: '#9ca3af', fontWeight: 700, fontSize: 16, lineHeight: 1, flexShrink: 0 },
  stepNum:          { width: 18, height: 18, borderRadius: '50%', background: '#e0e7ff', color: '#4f46e5', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  commitOwner:      { fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 8, background: '#d1fae5', color: '#065f46', flexShrink: 0 },

  // Buttons
  btnPrimary:       { padding: '7px 16px', borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  btnSecondary:     { padding: '7px 12px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 12, cursor: 'pointer' },
  btnOutline:       { padding: '6px 14px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 12, cursor: 'pointer', marginTop: 4 },
  btnTiny:          { padding: '3px 8px', borderRadius: 5, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 11, cursor: 'pointer' },
};
