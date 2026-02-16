import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import MeetingForm from './MeetingForm';
import CalendarSyncStatus from './CalendarSyncStatus';
import './CalendarView.css';

function CalendarView() {
  const [meetings, setMeetings] = useState([]);
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingMeeting, setEditingMeeting] = useState(null);
  const [selectedMeeting, setSelectedMeeting] = useState(null);
  const [error, setError] = useState('');
  
  // Get user ID from localStorage
  const userId = JSON.parse(localStorage.getItem('user') || '{}').id;

  useEffect(() => {
    loadMeetings();
  }, []);

  const loadMeetings = async () => {
    try {
      setLoading(true);
      setError('');

      const [meetingsRes, dealsRes, contactsRes] = await Promise.all([
        apiService.meetings.getAll().catch(() => ({ data: { meetings: mockData.meetings } })),
        apiService.deals.getAll().catch(() => ({ data: { deals: mockData.deals } })),
        apiService.contacts.getAll().catch(() => ({ data: { contacts: mockData.contacts } }))
      ]);

      const enrichedData = enrichData({
        accounts: mockData.accounts,
        deals: dealsRes.data.deals || dealsRes.data || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        emails: [],
        meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        actions: []
      });

      setMeetings(enrichedData.meetings);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);

    } catch (err) {
      console.error('Error loading meetings:', err);
      setError('Failed to load meetings. Using sample data.');
      
      const enrichedData = enrichData({
        ...mockData,
        emails: [],
        actions: []
      });
      
      setMeetings(enrichedData.meetings);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMeeting = async (meetingData) => {
    try {
      const response = await apiService.meetings.create(meetingData);
      const newMeeting = response.data.meeting || response.data;
      
      const deal = deals.find(d => d.id === newMeeting.deal_id);
      const enrichedMeeting = { 
        ...newMeeting, 
        deal,
        status: 'scheduled'
      };
      
      setMeetings([...meetings, enrichedMeeting]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error creating meeting:', err);
      const newMeeting = { 
        ...meetingData,
        id: Date.now(),
        deal: deals.find(d => d.id === meetingData.deal_id),
        status: 'scheduled',
        created_at: new Date().toISOString()
      };
      setMeetings([...meetings, newMeeting]);
      setShowForm(false);
    }
  };

  const handleUpdateMeeting = async (meetingData) => {
    try {
      const response = await apiService.meetings.update(editingMeeting.id, meetingData);
      const updatedMeeting = response.data.meeting || response.data;
      
      const deal = deals.find(d => d.id === updatedMeeting.deal_id);
      const enrichedMeeting = { ...updatedMeeting, deal };
      
      setMeetings(meetings.map(m => 
        m.id === editingMeeting.id ? enrichedMeeting : m
      ));
      setEditingMeeting(null);
      setError('');
    } catch (err) {
      console.error('Error updating meeting:', err);
      const deal = deals.find(d => d.id === meetingData.deal_id);
      setMeetings(meetings.map(m => 
        m.id === editingMeeting.id ? { ...m, ...meetingData, deal } : m
      ));
      setEditingMeeting(null);
    }
  };

  const handleDeleteMeeting = async (meetingId) => {
    if (!window.confirm('Are you sure you want to delete this meeting?')) {
      return;
    }

    try {
      await apiService.meetings.delete(meetingId);
      setMeetings(meetings.filter(m => m.id !== meetingId));
      if (selectedMeeting?.id === meetingId) {
        setSelectedMeeting(null);
      }
      setError('');
    } catch (err) {
      console.error('Error deleting meeting:', err);
      setMeetings(meetings.filter(m => m.id !== meetingId));
      if (selectedMeeting?.id === meetingId) {
        setSelectedMeeting(null);
      }
    }
  };

  const getMeetingAttendees = (meeting) => {
    if (!meeting.attendees || meeting.attendees.length === 0) return [];
    return contacts.filter(c => meeting.attendees.includes(c.id));
  };

  const groupMeetingsByDate = () => {
    const grouped = {};
    meetings.forEach(meeting => {
      const date = new Date(meeting.start_time).toDateString();
      if (!grouped[date]) {
        grouped[date] = [];
      }
      grouped[date].push(meeting);
    });
    
    // Sort meetings within each day
    Object.keys(grouped).forEach(date => {
      grouped[date].sort((a, b) => 
        new Date(a.start_time) - new Date(b.start_time)
      );
    });
    
    return grouped;
  };

  const groupedMeetings = groupMeetingsByDate();
  const sortedDates = Object.keys(groupedMeetings).sort((a, b) => 
    new Date(a) - new Date(b)
  );

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
            {meetings.length} meeting{meetings.length !== 1 ? 's' : ''} scheduled
          </p>
        </div>
        <div className="calendar-actions">
          <CalendarSyncStatus userId={userId} />
          <button className="btn-primary" onClick={() => setShowForm(true)}>
            📅 Schedule Meeting
          </button>
        </div>
      </div>

      {error && (
        <div className="info-banner">
          ℹ️ {error}
        </div>
      )}

      {/* Calendar Container */}
      <div className={`calendar-container ${selectedMeeting ? 'with-detail' : ''}`}>
        {/* Meetings Timeline */}
        <div className="meetings-timeline">
          {sortedDates.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📅</div>
              <h3>No meetings scheduled</h3>
              <p>Schedule your first meeting to get started</p>
              <button className="btn-primary" onClick={() => setShowForm(true)}>
                📅 Schedule Meeting
              </button>
            </div>
          ) : (
            sortedDates.map(date => (
              <div key={date} className="date-section">
                <div className="date-header">
                  <h2>{new Date(date).toLocaleDateString('en-US', { 
                    weekday: 'long', 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                  })}</h2>
                  <span className="meeting-count">
                    {groupedMeetings[date].length} meeting{groupedMeetings[date].length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="meetings-list">
                  {groupedMeetings[date].map(meeting => (
                    <MeetingCard
                      key={meeting.id}
                      meeting={meeting}
                      attendees={getMeetingAttendees(meeting)}
                      onEdit={() => setEditingMeeting(meeting)}
                      onDelete={() => handleDeleteMeeting(meeting.id)}
                      onSelect={() => setSelectedMeeting(meeting)}
                      isSelected={selectedMeeting?.id === meeting.id}
                    />
                  ))}
                </div>
              </div>
            ))
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
              {/* Meeting Time */}
              <div className="detail-section">
                <h3>When</h3>
                <div className="meeting-time-info">
                  <div className="time-block">
                    <span className="time-label">Start:</span>
                    <span className="time-value">
                      {new Date(selectedMeeting.start_time).toLocaleString()}
                    </span>
                  </div>
                  <div className="time-block">
                    <span className="time-label">End:</span>
                    <span className="time-value">
                      {new Date(selectedMeeting.end_time).toLocaleString()}
                    </span>
                  </div>
                  <div className="time-block">
                    <span className="time-label">Duration:</span>
                    <span className="time-value">
                      {Math.round((new Date(selectedMeeting.end_time) - new Date(selectedMeeting.start_time)) / (1000 * 60))} minutes
                    </span>
                  </div>
                </div>
              </div>

              {/* Meeting Details */}
              <div className="detail-section">
                <h3>Details</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Type</span>
                    <span className={`detail-badge meeting-type-${selectedMeeting.meeting_type}`}>
                      {selectedMeeting.meeting_type}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Status</span>
                    <span className={`detail-badge status-${selectedMeeting.status}`}>
                      {selectedMeeting.status}
                    </span>
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
                      <span>
                        {selectedMeeting.deal.name} - ${parseFloat(selectedMeeting.deal.value).toLocaleString()}
                      </span>
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

              {/* Attendees */}
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
                          <div className="item-name">
                            {attendee.first_name} {attendee.last_name}
                          </div>
                          <div className="item-meta">
                            {attendee.title}
                            {attendee.account && ` • ${attendee.account.name}`}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Quick Actions */}
              <div className="detail-section">
                <h3>Quick Actions</h3>
                <div className="quick-actions">
                  <button 
                    className="btn-action"
                    onClick={() => setEditingMeeting(selectedMeeting)}
                  >
                    ✏️ Edit Meeting
                  </button>
                  <button 
                    className="btn-action"
                    onClick={() => handleDeleteMeeting(selectedMeeting.id)}
                  >
                    🗑️ Delete Meeting
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Meeting Form Modal */}
      {(showForm || editingMeeting) && (
        <MeetingForm
          meeting={editingMeeting}
          deals={deals}
          contacts={contacts}
          onSubmit={editingMeeting ? handleUpdateMeeting : handleCreateMeeting}
          onClose={() => {
            setShowForm(false);
            setEditingMeeting(null);
          }}
        />
      )}
    </div>
  );
}

function MeetingCard({ meeting, attendees, onEdit, onDelete, onSelect, isSelected }) {
  const startTime = new Date(meeting.start_time);
  const endTime = new Date(meeting.end_time);
  const duration = Math.round((endTime - startTime) / (1000 * 60));

  return (
    <div 
      className={`meeting-card ${isSelected ? 'selected' : ''} type-${meeting.meeting_type}`}
      onClick={onSelect}
    >
      <div className="meeting-card-time">
        <div className="time-start">
          {startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </div>
        <div className="time-duration">{duration}min</div>
      </div>

      <div className="meeting-card-content">
        <div className="meeting-card-header">
          <h3 className="meeting-title">{meeting.title}</h3>
          <div className="meeting-actions">
            <button 
              onClick={(e) => { e.stopPropagation(); onEdit(); }} 
              className="icon-btn" 
              title="Edit"
            >
              ✏️
            </button>
            <button 
              onClick={(e) => { e.stopPropagation(); onDelete(); }} 
              className="icon-btn" 
              title="Delete"
            >
              🗑️
            </button>
          </div>
        </div>

        {meeting.description && (
          <p className="meeting-description">{meeting.description}</p>
        )}

        <div className="meeting-meta">
          <span className={`meeting-type ${meeting.meeting_type}`}>
            {meeting.meeting_type}
          </span>
          {meeting.source && meeting.source !== 'manual' && (
            <span className={`meeting-source-badge ${meeting.source}`}>
              {meeting.source === 'outlook' ? '📧 Outlook' : '📅 ' + meeting.source}
            </span>
          )}
          {meeting.location && (
            <span className="meeting-location">📍 {meeting.location}</span>
          )}
          {meeting.deal && (
            <span className="meeting-deal">💼 {meeting.deal.name}</span>
          )}
        </div>

        {attendees.length > 0 && (
          <div className="meeting-attendees">
            <span className="attendees-label">👥</span>
            {attendees.slice(0, 3).map(a => (
              <span key={a.id} className="attendee-badge">
                {a.first_name} {a.last_name}
              </span>
            ))}
            {attendees.length > 3 && (
              <span className="attendees-more">+{attendees.length - 3} more</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default CalendarView;
