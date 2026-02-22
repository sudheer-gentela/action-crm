import React, { useState, useEffect, useRef } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import MeetingForm from './MeetingForm';
import CalendarSyncStatus from './CalendarSyncStatus';
import './CalendarView.css';

// Distinct, accessible priority colours (critical ≠ high)
const PRIORITY_COLORS = {
  critical: { bg: '#fdf2f8', border: '#9d174d', text: '#9d174d', dot: '#9d174d' }, // deep pink/magenta
  high:     { bg: '#fee2e2', border: '#dc2626', text: '#991b1b', dot: '#dc2626' }, // red
  medium:   { bg: '#fef3c7', border: '#d97706', text: '#92400e', dot: '#d97706' }, // amber
  low:      { bg: '#d1fae5', border: '#059669', text: '#065f46', dot: '#059669' }, // green
};

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function toLocalDateKey(dateVal) {
  const d = new Date(dateVal);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayKey() { return toLocalDateKey(new Date()); }

// ── Filter defaults ────────────────────────────────────────────
// showType:   'all' | 'meetings' | 'tasks'
// priorities: Set of selected priorities; empty Set = all selected
// dateRange:  'upcoming' | 'overdue' | 'all'
const ALL_PRIORITIES     = ['critical', 'high', 'medium', 'low'];
const DEFAULT_SHOW_TYPE  = 'all';
const DEFAULT_DATE_RANGE = 'upcoming';

// Snooze durations
const SNOOZE_OPTIONS = [
  { label: '1 day',   days: 1 },
  { label: '3 days',  days: 3 },
  { label: '1 week',  days: 7 },
  { label: '2 weeks', days: 14 },
];

function CalendarView() {
  const [meetings, setMeetings]               = useState([]);
  const [actions, setActions]                 = useState([]);
  const [deals, setDeals]                     = useState([]);
  const [contacts, setContacts]               = useState([]);
  const [loading, setLoading]                 = useState(true);
  const [showForm, setShowForm]               = useState(false);
  const [editingMeeting, setEditingMeeting]   = useState(null);
  const [selectedMeeting, setSelectedMeeting] = useState(null);
  const [activeAction, setActiveAction]       = useState(null); // { action, rect }
  const [snoozeAction, setSnoozeAction]       = useState(null); // action being snoozed
  const [error, setError]                     = useState('');

  // ── Filter state ───────────────────────────────────────────
  const [showType,       setShowType]       = useState(DEFAULT_SHOW_TYPE);
  // Empty set = "All" (no filter). Non-empty = show only selected priorities.
  const [priorities,     setPriorities]     = useState(new Set());
  const [priorityOpen,   setPriorityOpen]   = useState(false);
  const [dateRange,      setDateRange]      = useState(DEFAULT_DATE_RANGE);

  const priorityDropRef = useRef(null);

  const popoverRef = useRef(null);
  const snoozeRef  = useRef(null);
  const userId = JSON.parse(localStorage.getItem('user') || '{}').id;

  useEffect(() => { loadData(); }, []);

  // Close action popover on outside click
  useEffect(() => {
    if (!activeAction && !snoozeAction) return;
    const handler = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setActiveAction(null);
      if (snoozeRef.current  && !snoozeRef.current.contains(e.target))  setSnoozeAction(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeAction, snoozeAction]);

  // Close priority dropdown on outside click
  useEffect(() => {
    if (!priorityOpen) return;
    const handler = (e) => {
      if (priorityDropRef.current && !priorityDropRef.current.contains(e.target)) {
        setPriorityOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [priorityOpen]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const [meetingsRes, dealsRes, contactsRes, actionsRes] = await Promise.all([
        apiService.meetings.getAll().catch(() => ({ data: { meetings: mockData.meetings } })),
        apiService.deals.getAll().catch(() => ({ data: { deals: mockData.deals } })),
        apiService.contacts.getAll().catch(() => ({ data: { contacts: mockData.contacts } })),
        apiService.actions.getAll({ hasDueDate: true }).catch(() => ({ data: { actions: [] } })),
      ]);

      const enrichedData = enrichData({
        accounts: mockData.accounts,
        deals:    dealsRes.data.deals       || dealsRes.data    || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        emails:   [],
        meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        actions:  [],
      });

      setMeetings(enrichedData.meetings);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);

      const rawActions = actionsRes.data.actions || actionsRes.data || [];
      // Store ALL non-completed, non-snoozed actions that have a due date
      setActions(rawActions.filter(a => a.dueDate && a.status !== 'completed' && !a.snoozedUntil));
    } catch (err) {
      console.error('Error loading calendar data:', err);
      setError('Failed to load some data. Showing available information.');
      const enrichedData = enrichData({ ...mockData, emails: [], actions: [] });
      setMeetings(enrichedData.meetings);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);
    } finally {
      setLoading(false);
    }
  };

  // ── Action mutations ───────────────────────────────────────
  const handleActionComplete = async (actionId) => {
    try {
      await apiService.actions.complete(actionId);
    } catch (err) { console.error(err); }
    setActions(prev => prev.filter(a => a.id !== actionId));
    setActiveAction(null);
    setSnoozeAction(null);
  };

  const handleActionStart = async (actionId) => {
    try {
      await apiService.actions.updateStatus(actionId, 'in_progress');
      setActions(prev => prev.map(a => a.id === actionId ? { ...a, status: 'in_progress' } : a));
      setActiveAction(prev => prev ? { ...prev, action: { ...prev.action, status: 'in_progress' } } : null);
    } catch (err) { console.error(err); }
  };

  // Launch the floating context panel — App.js listens for 'startAction'
  const handleLaunchContextPanel = (action) => {
    handleActionStart(action.id);   // mark in_progress
    setActiveAction(null);          // close the popover
    window.dispatchEvent(new CustomEvent('startAction', { detail: action }));
  };

  const handleSnooze = async (actionId, days) => {
    try {
      await apiService.actions.snooze(actionId, 'snoozed from calendar', days + 'd');
    } catch (err) { console.error(err); }
    setActions(prev => prev.filter(a => a.id !== actionId));
    setActiveAction(null);
    setSnoozeAction(null);
  };

  // ── Meeting mutations ──────────────────────────────────────
  const handleCreateMeeting = async (meetingData) => {
    try {
      const response = await apiService.meetings.create(meetingData);
      const newMeeting = response.data.meeting || response.data;
      const deal = deals.find(d => d.id === newMeeting.deal_id);
      setMeetings([...meetings, { ...newMeeting, deal, status: 'scheduled' }]);
      setShowForm(false);
    } catch (err) {
      console.error(err);
      setMeetings([...meetings, {
        ...meetingData, id: Date.now(),
        deal: deals.find(d => d.id === meetingData.deal_id),
        status: 'scheduled', created_at: new Date().toISOString(),
      }]);
      setShowForm(false);
    }
  };

  const handleUpdateMeeting = async (meetingData) => {
    try {
      const response = await apiService.meetings.update(editingMeeting.id, meetingData);
      const updated = response.data.meeting || response.data;
      const deal = deals.find(d => d.id === updated.deal_id);
      setMeetings(meetings.map(m => m.id === editingMeeting.id ? { ...updated, deal } : m));
    } catch (err) {
      console.error(err);
      const deal = deals.find(d => d.id === meetingData.deal_id);
      setMeetings(meetings.map(m => m.id === editingMeeting.id ? { ...m, ...meetingData, deal } : m));
    }
    setEditingMeeting(null);
  };

  const handleDeleteMeeting = async (meetingId) => {
    if (!window.confirm('Are you sure you want to delete this meeting?')) return;
    try { await apiService.meetings.delete(meetingId); } catch (err) { console.error(err); }
    setMeetings(meetings.filter(m => m.id !== meetingId));
    if (selectedMeeting?.id === meetingId) setSelectedMeeting(null);
  };

  const getMeetingAttendees = (meeting) => {
    if (!meeting.attendees?.length) return [];
    return contacts.filter(c => meeting.attendees.includes(c.id));
  };

  // ── Date grouping ──────────────────────────────────────────
  const groupMeetingsByDate = () => {
    const grouped = {};
    const now = new Date(); now.setHours(0,0,0,0);
    meetings
      .filter(m => new Date(m.start_time) >= now)
      .forEach(m => {
        const key = toLocalDateKey(m.start_time);
        (grouped[key] = grouped[key] || []).push(m);
      });
    Object.keys(grouped).forEach(k => grouped[k].sort((a,b) => new Date(a.start_time) - new Date(b.start_time)));
    return grouped;
  };

  // Returns actions filtered by priority and dateRange
  const getFilteredActions = () => {
    const today = todayKey();
    return actions.filter(a => {
      // Empty set = All; non-empty = must be in set
      if (priorities.size > 0 && !priorities.has(a.priority)) return false;
      const key = toLocalDateKey(a.dueDate);
      if (dateRange === 'upcoming') return key >= today;
      if (dateRange === 'overdue')  return key < today;
      return true; // 'all'
    });
  };

  const groupActionsByDate = (filteredActions) => {
    const grouped = {};
    filteredActions.forEach(a => {
      const key = toLocalDateKey(a.dueDate);
      (grouped[key] = grouped[key] || []).push(a);
    });
    // Sort within each day by priority then title
    Object.keys(grouped).forEach(k => {
      grouped[k].sort((a,b) =>
        (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) || a.title.localeCompare(b.title)
      );
    });
    return grouped;
  };

  // ── Compute visible sets ───────────────────────────────────
  const showMeetings    = showType === 'all' || showType === 'meetings';
  const showTasks       = showType === 'all' || showType === 'tasks';
  const groupedMeetings = showMeetings ? groupMeetingsByDate() : {};
  const filteredActions = showTasks    ? getFilteredActions()  : [];
  const groupedActions  = groupActionsByDate(filteredActions);

  const allDateKeys = Array.from(
    new Set([...Object.keys(groupedMeetings), ...Object.keys(groupedActions)])
  ).sort();

  const upcomingMeetingsCount = Object.values(groupedMeetings).reduce((s,d) => s + d.length, 0);
  const visibleActionsCount   = filteredActions.length;
  const overdueCount          = actions.filter(a => toLocalDateKey(a.dueDate) < todayKey()).length;

  // ── Priority toggle helper ─────────────────────────────────
  const togglePriority = (p) => {
    setPriorities(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  // Label shown on the priority dropdown trigger
  const priorityLabel = () => {
    if (priorities.size === 0) return 'All';
    if (priorities.size === ALL_PRIORITIES.length) return 'All';
    return [...priorities].map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');
  };

  // ── Pill click handler ─────────────────────────────────────
  const handleActionPillClick = (e, action) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setActiveAction({ action, rect });
    setSelectedMeeting(null);
    setSnoozeAction(null);
  };

  if (loading) {
    return (
      <div className="calendar-view">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading calendar...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="calendar-view">
      {/* Header */}
      <div className="calendar-header">
        <div>
          <h1>Calendar</h1>
          <p className="calendar-subtitle">
            {showMeetings && <>{upcomingMeetingsCount} meeting{upcomingMeetingsCount !== 1 ? 's' : ''}</>}
            {showMeetings && showTasks && ' · '}
            {showTasks && <>{visibleActionsCount} task{visibleActionsCount !== 1 ? 's' : ''}</>}
          </p>
        </div>
        <div className="calendar-actions">
          <CalendarSyncStatus userId={userId} />
          <button className="btn-primary" onClick={() => setShowForm(true)}>📅 Schedule Meeting</button>
        </div>
      </div>

      {error && <div className="info-banner">ℹ️ {error}</div>}

      {/* ── Filter Bar ── */}
      <div className="filter-bar">
        {/* Show filter — segmented button group */}
        <div className="filter-group">
          <span className="filter-group-label">Show</span>
          <div className="filter-segment">
            {[
              { key: 'all',      label: 'All' },
              { key: 'meetings', label: '📅 Meetings' },
              { key: 'tasks',    label: '✓ Tasks' },
            ].map(opt => (
              <button
                key={opt.key}
                className={`segment-btn ${showType === opt.key ? 'active' : ''}`}
                onClick={() => setShowType(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Priority multiselect — only when tasks are visible */}
        {showTasks && (
          <div className="filter-group" ref={priorityDropRef}>
            <span className="filter-group-label">Priority</span>
            <div className="priority-dropdown">
              {/* Trigger */}
              <button
                className={`priority-trigger ${priorities.size > 0 && priorities.size < ALL_PRIORITIES.length ? 'has-selection' : ''}`}
                onClick={() => setPriorityOpen(o => !o)}
              >
                {/* Coloured dots for selected priorities */}
                {priorities.size > 0 && priorities.size < ALL_PRIORITIES.length ? (
                  <span className="trigger-dots">
                    {ALL_PRIORITIES.filter(p => priorities.has(p)).map(p => (
                      <span key={p} className="trigger-dot" style={{ background: PRIORITY_COLORS[p].dot }}></span>
                    ))}
                  </span>
                ) : null}
                <span className="trigger-label">{priorityLabel()}</span>
                <span className={`trigger-chevron ${priorityOpen ? 'open' : ''}`}>▾</span>
              </button>

              {/* Dropdown panel */}
              {priorityOpen && (
                <div className="priority-panel">
                  {/* All option */}
                  <label className="priority-option priority-option-all">
                    <input
                      type="checkbox"
                      checked={priorities.size === 0}
                      onChange={() => setPriorities(new Set())}
                    />
                    <span className="option-label">All</span>
                  </label>
                  <div className="priority-divider"></div>
                  {ALL_PRIORITIES.map(p => {
                    const c = PRIORITY_COLORS[p];
                    return (
                      <label key={p} className="priority-option">
                        <input
                          type="checkbox"
                          checked={priorities.has(p)}
                          onChange={() => togglePriority(p)}
                        />
                        <span className="option-dot" style={{ background: c.dot }}></span>
                        <span className="option-label" style={{ color: c.text }}>
                          {p.charAt(0).toUpperCase() + p.slice(1)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Due Date dropdown — only when tasks are visible */}
        {showTasks && (
          <div className="filter-group">
            <span className="filter-group-label">Due Date</span>
            <div className="filter-select-wrap">
              <select
                className={`filter-select ${dateRange === 'overdue' ? 'select-overdue' : ''}`}
                value={dateRange}
                onChange={e => setDateRange(e.target.value)}
              >
                <option value="upcoming">Upcoming</option>
                <option value="overdue">
                  {overdueCount > 0 ? `Overdue (${overdueCount})` : 'Overdue'}
                </option>
                <option value="all">All</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Calendar Container */}
      <div className={`calendar-container ${selectedMeeting ? 'with-detail' : ''}`}>
        <div className="meetings-timeline">
          {allDateKeys.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📅</div>
              <h3>{dateRange === 'overdue' ? 'No overdue tasks' : 'Nothing scheduled'}</h3>
              <p>{dateRange === 'overdue' ? "You're all caught up!" : 'Schedule a meeting or adjust your filters'}</p>
              {dateRange !== 'overdue' && (
                <button className="btn-primary" onClick={() => setShowForm(true)}>📅 Schedule Meeting</button>
              )}
            </div>
          ) : (
            allDateKeys.map(dateKey => {
              const dayMeetings = groupedMeetings[dateKey] || [];
              const dayActions  = groupedActions[dateKey]  || [];
              const dateObj     = new Date(dateKey + 'T00:00:00');
              const isToday     = dateKey === todayKey();
              const isPast      = dateKey < todayKey();

              return (
                <div key={dateKey} className={`date-section${isPast ? ' past-date' : ''}`}>
                  <div className="date-header">
                    <h2>
                      {isToday && <span className="today-badge">Today</span>}
                      {dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                    </h2>
                    <div className="date-header-counts">
                      {dayMeetings.length > 0 && (
                        <span className="meeting-count">{dayMeetings.length} meeting{dayMeetings.length !== 1 ? 's' : ''}</span>
                      )}
                      {dayActions.length > 0 && (
                        <span className={`action-count${isPast ? ' overdue-count' : ''}`}>
                          {isPast && '⚠️ '}{dayActions.length} task{dayActions.length !== 1 ? 's' : ''}{isPast ? ' overdue' : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Action pills for this day */}
                  {dayActions.length > 0 && (
                    <div className="action-pills-row">
                      {dayActions.map(a => (
                        <ActionPill key={a.id} action={a} isOverdue={isPast} onClick={handleActionPillClick} />
                      ))}
                    </div>
                  )}

                  {/* Meeting cards */}
                  {dayMeetings.length > 0 && (
                    <div className="meetings-list">
                      {dayMeetings.map(meeting => (
                        <MeetingCard
                          key={meeting.id}
                          meeting={meeting}
                          attendees={getMeetingAttendees(meeting)}
                          onEdit={() => setEditingMeeting(meeting)}
                          onDelete={() => handleDeleteMeeting(meeting.id)}
                          onSelect={() => { setSelectedMeeting(meeting); setActiveAction(null); }}
                          isSelected={selectedMeeting?.id === meeting.id}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Meeting Detail Panel */}
        {selectedMeeting && (
          <div className="meeting-detail-panel">
            <div className="panel-header">
              <h2>{selectedMeeting.title}</h2>
              <button className="close-panel" onClick={() => setSelectedMeeting(null)}>×</button>
            </div>
            <div className="panel-content">
              <div className="detail-section">
                <h3>When</h3>
                <div className="meeting-time-info">
                  <div className="time-block">
                    <span className="time-label">Start:</span>
                    <span className="time-value">{new Date(selectedMeeting.start_time).toLocaleString()}</span>
                  </div>
                  <div className="time-block">
                    <span className="time-label">End:</span>
                    <span className="time-value">{new Date(selectedMeeting.end_time).toLocaleString()}</span>
                  </div>
                  <div className="time-block">
                    <span className="time-label">Duration:</span>
                    <span className="time-value">
                      {Math.round((new Date(selectedMeeting.end_time) - new Date(selectedMeeting.start_time)) / 60000)} minutes
                    </span>
                  </div>
                </div>
              </div>
              <div className="detail-section">
                <h3>Details</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Type</span>
                    <span className={`detail-badge meeting-type-${selectedMeeting.meeting_type}`}>{selectedMeeting.meeting_type}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Status</span>
                    <span className={`detail-badge status-${selectedMeeting.status}`}>{selectedMeeting.status}</span>
                  </div>
                  {selectedMeeting.location && (
                    <div className="detail-item full-width">
                      <span className="detail-label">Location</span>
                      <span>{selectedMeeting.location}</span>
                    </div>
                  )}
                  {selectedMeeting.deal && (
                    <div className="detail-item full-width">
                      <span className="detail-label">Related Deal</span>
                      <span>{selectedMeeting.deal.name} — ${parseFloat(selectedMeeting.deal.value).toLocaleString()}</span>
                    </div>
                  )}
                </div>
                {selectedMeeting.description && (
                  <div className="detail-description">
                    <span className="detail-label">Agenda</span>
                    <p>{selectedMeeting.description}</p>
                  </div>
                )}
              </div>
              <div className="detail-section">
                <h3>Attendees ({getMeetingAttendees(selectedMeeting).length})</h3>
                {getMeetingAttendees(selectedMeeting).length === 0 ? (
                  <p className="empty-message">No attendees added</p>
                ) : (
                  <div className="linked-items-list">
                    {getMeetingAttendees(selectedMeeting).map(attendee => (
                      <div key={attendee.id} className="linked-item">
                        <span className="item-icon">👤</span>
                        <div className="item-info">
                          <div className="item-name">{attendee.first_name} {attendee.last_name}</div>
                          <div className="item-meta">{attendee.title}{attendee.account && ` • ${attendee.account.name}`}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="detail-section">
                <h3>Quick Actions</h3>
                <div className="quick-actions">
                  <button className="btn-action" onClick={() => setEditingMeeting(selectedMeeting)}>✏️ Edit Meeting</button>
                  <button className="btn-action" onClick={() => handleDeleteMeeting(selectedMeeting.id)}>🗑️ Delete Meeting</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Action Popover */}
      {activeAction && (
        <ActionPopover
          action={activeAction.action}
          anchorRect={activeAction.rect}
          onClose={() => setActiveAction(null)}
          onStart={handleLaunchContextPanel}
          onComplete={handleActionComplete}
          onSnoozeRequest={(action) => { setSnoozeAction(action); setActiveAction(null); }}
          ref={popoverRef}
        />
      )}

      {/* Snooze Picker */}
      {snoozeAction && (
        <SnoozePicker
          action={snoozeAction}
          onSnooze={handleSnooze}
          onClose={() => setSnoozeAction(null)}
          ref={snoozeRef}
        />
      )}

      {/* Meeting Form */}
      {(showForm || editingMeeting) && (
        <MeetingForm
          meeting={editingMeeting}
          deals={deals}
          contacts={contacts}
          onSubmit={editingMeeting ? handleUpdateMeeting : handleCreateMeeting}
          onClose={() => { setShowForm(false); setEditingMeeting(null); }}
        />
      )}
    </div>
  );
}

// ── ActionPill ─────────────────────────────────────────────────
function ActionPill({ action, isOverdue, onClick }) {
  const colors = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
  return (
    <button
      className={`action-pill priority-${action.priority}${isOverdue ? ' overdue' : ''}`}
      onClick={(e) => onClick(e, action)}
      title={`${action.title}${action.deal?.name ? ' · ' + action.deal.name : ''}`}
    >
      <span className="pill-dot" style={{ background: colors.dot }}></span>
      <span className="pill-label">{action.title}</span>
      {action.deal?.name && <span className="pill-deal">{action.deal.name}</span>}
      {action.status === 'in_progress' && <span className="pill-in-progress">▶</span>}
    </button>
  );
}

// ── ActionPopover ──────────────────────────────────────────────
const ActionPopover = React.forwardRef(function ActionPopover(
  { action, anchorRect, onClose, onStart, onComplete, onSnoozeRequest }, ref
) {
  const colors = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
  const style = {
    position: 'fixed',
    top: Math.min(anchorRect.bottom + 8, window.innerHeight - 280),
    left: Math.min(anchorRect.left, window.innerWidth - 320),
    zIndex: 1000,
  };

  return (
    <div className="action-popover" style={style} ref={ref}>
      <div className="popover-header" style={{ borderLeftColor: colors.dot }}>
        <div className="popover-title">{action.title}</div>
        <button className="popover-close" onClick={onClose}>×</button>
      </div>
      <div className="popover-body">
        <div className="popover-meta">
          <span className="popover-priority" style={{ background: colors.bg, color: colors.text, border: `1px solid ${colors.border}` }}>
            {action.priority}
          </span>
          <span className="popover-status">{action.status?.replace(/_/g, ' ')}</span>
        </div>
        {action.deal?.name && <div className="popover-deal">💼 {action.deal.name}</div>}
        {action.description && <p className="popover-description">{action.description}</p>}
        <div className="popover-due">
          📅 Due {new Date(action.dueDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
        </div>
      </div>
      <div className="popover-actions">
        {action.status !== 'in_progress' && (
          <button className="popover-btn popover-btn-start" onClick={() => onStart(action)}>🚀 Start & Open</button>
        )}
        <button className="popover-btn popover-btn-snooze" onClick={() => onSnoozeRequest(action)}>
          💤 Snooze
        </button>
        <button className="popover-btn popover-btn-done" onClick={() => onComplete(action.id)}>✓ Done</button>
      </div>
    </div>
  );
});

// ── SnoozePicker ───────────────────────────────────────────────
const SnoozePicker = React.forwardRef(function SnoozePicker({ action, onSnooze, onClose }, ref) {
  const colors = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
  // Position: centered-ish
  const style = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 1001,
  };

  return (
    <>
      <div className="popover-overlay" onClick={onClose}></div>
      <div className="snooze-picker" style={style} ref={ref}>
        <div className="snooze-header" style={{ borderLeftColor: colors.dot }}>
          <div>
            <div className="snooze-title">💤 Snooze task</div>
            <div className="snooze-subtitle">{action.title}</div>
          </div>
          <button className="popover-close" onClick={onClose}>×</button>
        </div>
        <div className="snooze-body">
          <p className="snooze-instruction">Snooze for how long?</p>
          <div className="snooze-options">
            {SNOOZE_OPTIONS.map(opt => (
              <button
                key={opt.days}
                className="snooze-option"
                onClick={() => onSnooze(action.id, opt.days)}
              >
                <span className="snooze-option-label">{opt.label}</span>
                <span className="snooze-option-date">
                  Until {new Date(Date.now() + opt.days * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="snooze-footer">
          <button className="popover-btn popover-btn-done" onClick={() => { /* onComplete handled by parent */ }}>
            ✓ Mark complete instead
          </button>
        </div>
      </div>
    </>
  );
});

// ── MeetingCard (unchanged) ────────────────────────────────────
function MeetingCard({ meeting, attendees, onEdit, onDelete, onSelect, isSelected }) {
  const startTime = new Date(meeting.start_time);
  const endTime   = new Date(meeting.end_time);
  const duration  = Math.round((endTime - startTime) / 60000);

  return (
    <div className={`meeting-card ${isSelected ? 'selected' : ''} type-${meeting.meeting_type}`} onClick={onSelect}>
      <div className="meeting-card-time">
        <div className="time-start">{startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
        <div className="time-duration">{duration}min</div>
      </div>
      <div className="meeting-card-content">
        <div className="meeting-card-header">
          <h3 className="meeting-title">{meeting.title}</h3>
          <div className="meeting-actions">
            <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="icon-btn" title="Edit">✏️</button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="icon-btn" title="Delete">🗑️</button>
          </div>
        </div>
        {meeting.description && <p className="meeting-description">{meeting.description}</p>}
        <div className="meeting-meta">
          <span className={`meeting-type ${meeting.meeting_type}`}>{meeting.meeting_type}</span>
          {meeting.source && meeting.source !== 'manual' && (
            <span className={`meeting-source-badge ${meeting.source}`}>
              {meeting.source === 'outlook' ? '📧 Outlook' : '📅 ' + meeting.source}
            </span>
          )}
          {meeting.location && <span className="meeting-location">📍 {meeting.location}</span>}
          {meeting.deal && <span className="meeting-deal">💼 {meeting.deal.name}</span>}
        </div>
        {attendees.length > 0 && (
          <div className="meeting-attendees">
            <span className="attendees-label">👥</span>
            {attendees.slice(0, 3).map(a => (
              <span key={a.id} className="attendee-badge">{a.first_name} {a.last_name}</span>
            ))}
            {attendees.length > 3 && <span className="attendees-more">+{attendees.length - 3} more</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export default CalendarView;
