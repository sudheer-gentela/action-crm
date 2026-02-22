import React, { useState, useEffect, useRef } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import MeetingForm from './MeetingForm';
import CalendarSyncStatus from './CalendarSyncStatus';
import './CalendarView.css';

// Priority colours for action pills
const PRIORITY_COLORS = {
  critical: { bg: '#fee2e2', border: '#dc2626', text: '#991b1b', dot: '#dc2626' },
  high:     { bg: '#fee2e2', border: '#ef4444', text: '#b91c1c', dot: '#ef4444' },
  medium:   { bg: '#fef3c7', border: '#f59e0b', text: '#92400e', dot: '#f59e0b' },
  low:      { bg: '#d1fae5', border: '#10b981', text: '#065f46', dot: '#10b981' },
};

function toLocalDateKey(dateVal) {
  const d = new Date(dateVal);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CalendarView() {
  const [meetings, setMeetings]               = useState([]);
  const [actions, setActions]                 = useState([]);
  const [deals, setDeals]                     = useState([]);
  const [contacts, setContacts]               = useState([]);
  const [loading, setLoading]                 = useState(true);
  const [showForm, setShowForm]               = useState(false);
  const [editingMeeting, setEditingMeeting]   = useState(null);
  const [selectedMeeting, setSelectedMeeting] = useState(null);
  const [activeAction, setActiveAction]       = useState(null);
  const [error, setError]                     = useState('');
  const popoverRef                            = useRef(null);

  const userId = JSON.parse(localStorage.getItem('user') || '{}').id;

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (!activeAction) return;
    const handler = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setActiveAction(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeAction]);

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
        deals:    dealsRes.data.deals    || dealsRes.data    || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        emails:   [],
        meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        actions:  [],
      });

      setMeetings(enrichedData.meetings);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);

      const rawActions = actionsRes.data.actions || actionsRes.data || [];
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

  const handleActionStatus = async (actionId, newStatus) => {
    try {
      if (newStatus === 'completed') {
        await apiService.actions.complete(actionId);
      } else {
        await apiService.actions.updateStatus(actionId, newStatus);
      }
      setActions(prev => prev.filter(a => a.id !== actionId));
      setActiveAction(null);
    } catch (err) {
      console.error('Error updating action status:', err);
    }
  };

  const handleCreateMeeting = async (meetingData) => {
    try {
      const response = await apiService.meetings.create(meetingData);
      const newMeeting = response.data.meeting || response.data;
      const deal = deals.find(d => d.id === newMeeting.deal_id);
      setMeetings([...meetings, { ...newMeeting, deal, status: 'scheduled' }]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error creating meeting:', err);
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
      setEditingMeeting(null);
      setError('');
    } catch (err) {
      console.error('Error updating meeting:', err);
      const deal = deals.find(d => d.id === meetingData.deal_id);
      setMeetings(meetings.map(m => m.id === editingMeeting.id ? { ...m, ...meetingData, deal } : m));
      setEditingMeeting(null);
    }
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

  const groupMeetingsByDate = () => {
    const grouped = {};
    const now = new Date(); now.setHours(0,0,0,0);
    meetings.filter(m => new Date(m.start_time) >= now).forEach(m => {
      const key = toLocalDateKey(m.start_time);
      (grouped[key] = grouped[key] || []).push(m);
    });
    Object.keys(grouped).forEach(k => grouped[k].sort((a,b) => new Date(a.start_time) - new Date(b.start_time)));
    return grouped;
  };

  const groupActionsByDate = () => {
    const grouped = {};
    const todayKey = toLocalDateKey(new Date());
    actions.forEach(a => {
      const key = toLocalDateKey(a.dueDate);
      const displayKey = key < todayKey ? todayKey : key;
      (grouped[displayKey] = grouped[displayKey] || []).push({ ...a, isOverdue: key < todayKey });
    });
    return grouped;
  };

  const groupedMeetings = groupMeetingsByDate();
  const groupedActions  = groupActionsByDate();
  const allDateKeys = Array.from(new Set([...Object.keys(groupedMeetings), ...Object.keys(groupedActions)])).sort();
  const upcomingMeetingsCount = Object.values(groupedMeetings).reduce((s, d) => s + d.length, 0);
  const pendingActionsCount   = actions.length;

  const handleActionPillClick = (e, action) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setActiveAction({ action, rect });
    setSelectedMeeting(null);
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
      <div className="calendar-header">
        <div>
          <h1>Calendar</h1>
          <p className="calendar-subtitle">
            {upcomingMeetingsCount} upcoming meeting{upcomingMeetingsCount !== 1 ? 's' : ''}
            {pendingActionsCount > 0 && (
              <> · <span className="actions-count-badge">{pendingActionsCount} action{pendingActionsCount !== 1 ? 's' : ''} due</span></>
            )}
          </p>
        </div>
        <div className="calendar-actions">
          <CalendarSyncStatus userId={userId} />
          <button className="btn-primary" onClick={() => setShowForm(true)}>📅 Schedule Meeting</button>
        </div>
      </div>

      {error && <div className="info-banner">ℹ️ {error}</div>}

      {pendingActionsCount > 0 && (
        <div className="calendar-legend">
          <span className="legend-item"><span className="legend-dot legend-dot-meeting"></span>Meeting</span>
          <span className="legend-item"><span className="legend-dot" style={{background:'#dc2626'}}></span>Critical</span>
          <span className="legend-item"><span className="legend-dot" style={{background:'#ef4444'}}></span>High</span>
          <span className="legend-item"><span className="legend-dot" style={{background:'#f59e0b'}}></span>Medium</span>
          <span className="legend-item"><span className="legend-dot" style={{background:'#10b981'}}></span>Low</span>
        </div>
      )}

      <div className={`calendar-container ${selectedMeeting ? 'with-detail' : ''}`}>
        <div className="meetings-timeline">
          {allDateKeys.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📅</div>
              <h3>No meetings scheduled</h3>
              <p>Schedule your first meeting to get started</p>
              <button className="btn-primary" onClick={() => setShowForm(true)}>📅 Schedule Meeting</button>
            </div>
          ) : (
            allDateKeys.map(dateKey => {
              const dayMeetings = groupedMeetings[dateKey] || [];
              const dayActions  = groupedActions[dateKey]  || [];
              const dateObj     = new Date(dateKey + 'T00:00:00');
              const isToday     = dateKey === toLocalDateKey(new Date());
              const overdue     = dayActions.filter(a => a.isOverdue);
              const dueOnDay    = dayActions.filter(a => !a.isOverdue);

              return (
                <div key={dateKey} className="date-section">
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
                        <span className="action-count">{dayActions.length} action{dayActions.length !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>

                  {overdue.length > 0 && (
                    <div className="overdue-strip">
                      <span className="overdue-label">⚠️ Overdue</span>
                      <div className="action-pills-row">
                        {overdue.map(a => <ActionPill key={a.id} action={a} onClick={handleActionPillClick} />)}
                      </div>
                    </div>
                  )}

                  {dueOnDay.length > 0 && (
                    <div className="action-pills-row due-today-row">
                      {dueOnDay.map(a => <ActionPill key={a.id} action={a} onClick={handleActionPillClick} />)}
                    </div>
                  )}

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

      {activeAction && (
        <ActionPopover
          action={activeAction.action}
          anchorRect={activeAction.rect}
          onClose={() => setActiveAction(null)}
          onStatusChange={handleActionStatus}
          ref={popoverRef}
        />
      )}

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

function ActionPill({ action, onClick }) {
  const colors = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
  return (
    <button
      className={`action-pill priority-${action.priority}${action.isOverdue ? ' overdue' : ''}`}
      onClick={(e) => onClick(e, action)}
      title={action.title}
    >
      <span className="pill-dot" style={{ background: colors.dot }}></span>
      <span className="pill-label">{action.title}</span>
      {action.deal?.name && <span className="pill-deal">{action.deal.name}</span>}
    </button>
  );
}

const ActionPopover = React.forwardRef(function ActionPopover({ action, anchorRect, onClose, onStatusChange }, ref) {
  const colors = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
  const style = {
    position: 'fixed',
    top: anchorRect.bottom + 8,
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
        {action.isOverdue && (
          <div className="popover-overdue-tag">
            ⚠️ Overdue — originally due {new Date(action.dueDate).toLocaleDateString()}
          </div>
        )}
      </div>
      <div className="popover-actions">
        {action.status !== 'in_progress' && (
          <button className="popover-btn popover-btn-start" onClick={() => onStatusChange(action.id, 'in_progress')}>▶ Start</button>
        )}
        <button className="popover-btn popover-btn-done" onClick={() => onStatusChange(action.id, 'completed')}>✓ Done</button>
      </div>
    </div>
  );
});

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
