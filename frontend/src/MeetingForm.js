import React, { useState, useEffect } from 'react';
import './MeetingForm.css';

function MeetingForm({ meeting, deals, contacts, onSubmit, onClose }) {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    start_time: '',
    end_time: '',
    meeting_type: 'discovery',
    deal_id: '',
    location: '',
    attendees: []
  });

  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (meeting) {
      setFormData({
        title: meeting.title || '',
        description: meeting.description || '',
        start_time: meeting.start_time ? meeting.start_time.slice(0, 16) : '',
        end_time: meeting.end_time ? meeting.end_time.slice(0, 16) : '',
        meeting_type: meeting.meeting_type || 'discovery',
        deal_id: meeting.deal_id || '',
        location: meeting.location || '',
        attendees: meeting.attendees || []
      });
    } else {
      // Default to next hour
      const now = new Date();
      now.setMinutes(0, 0, 0);
      now.setHours(now.getHours() + 1);
      const start = now.toISOString().slice(0, 16);
      now.setHours(now.getHours() + 1);
      const end = now.toISOString().slice(0, 16);
      
      setFormData(prev => ({
        ...prev,
        start_time: start,
        end_time: end
      }));
    }
  }, [meeting]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    if (errors[name]) {
      setErrors(prev => ({
        ...prev,
        [name]: null
      }));
    }
  };

  const handleAttendeeToggle = (contactId) => {
    setFormData(prev => ({
      ...prev,
      attendees: prev.attendees.includes(contactId)
        ? prev.attendees.filter(id => id !== contactId)
        : [...prev.attendees, contactId]
    }));
  };

  const validateForm = () => {
    const newErrors = {};

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required';
    }

    if (!formData.start_time) {
      newErrors.start_time = 'Start time is required';
    }

    if (!formData.end_time) {
      newErrors.end_time = 'End time is required';
    }

    if (formData.start_time && formData.end_time) {
      if (new Date(formData.end_time) <= new Date(formData.start_time)) {
        newErrors.end_time = 'End time must be after start time';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      await onSubmit(formData);
    } catch (error) {
      console.error('Error submitting form:', error);
      setErrors({ submit: 'Failed to save meeting. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedDeal = deals.find(d => d.id === parseInt(formData.deal_id));
  const dealContacts = selectedDeal 
    ? contacts.filter(c => c.account_id === selectedDeal.account_id)
    : contacts;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{meeting ? 'Edit Meeting' : 'Schedule Meeting'}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="meeting-form">
          {/* Title */}
          <div className="form-group">
            <label htmlFor="title">
              Meeting Title <span className="required">*</span>
            </label>
            <input
              type="text"
              id="title"
              name="title"
              value={formData.title}
              onChange={handleChange}
              placeholder="e.g., Product Demo with Acme Corp"
              className={errors.title ? 'error' : ''}
            />
            {errors.title && <span className="error-message">{errors.title}</span>}
          </div>

          {/* Date/Time Row */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="start_time">
                Start Time <span className="required">*</span>
              </label>
              <input
                type="datetime-local"
                id="start_time"
                name="start_time"
                value={formData.start_time}
                onChange={handleChange}
                className={errors.start_time ? 'error' : ''}
              />
              {errors.start_time && <span className="error-message">{errors.start_time}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="end_time">
                End Time <span className="required">*</span>
              </label>
              <input
                type="datetime-local"
                id="end_time"
                name="end_time"
                value={formData.end_time}
                onChange={handleChange}
                className={errors.end_time ? 'error' : ''}
              />
              {errors.end_time && <span className="error-message">{errors.end_time}</span>}
            </div>
          </div>

          {/* Meeting Type and Deal */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="meeting_type">Meeting Type</label>
              <select
                id="meeting_type"
                name="meeting_type"
                value={formData.meeting_type}
                onChange={handleChange}
              >
                <option value="discovery">Discovery Call</option>
                <option value="demo">Product Demo</option>
                <option value="negotiation">Negotiation</option>
                <option value="follow_up">Follow-up</option>
                <option value="closing">Closing Meeting</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="deal_id">Related Deal (Optional)</label>
              <select
                id="deal_id"
                name="deal_id"
                value={formData.deal_id}
                onChange={handleChange}
              >
                <option value="">No deal selected</option>
                {deals.map(deal => (
                  <option key={deal.id} value={deal.id}>
                    {deal.name} - ${parseFloat(deal.value).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Location */}
          <div className="form-group">
            <label htmlFor="location">Location / Meeting Link</label>
            <input
              type="text"
              id="location"
              name="location"
              value={formData.location}
              onChange={handleChange}
              placeholder="e.g., Zoom, Office, or address"
            />
          </div>

          {/* Description */}
          <div className="form-group">
            <label htmlFor="description">Description / Agenda</label>
            <textarea
              id="description"
              name="description"
              value={formData.description}
              onChange={handleChange}
              placeholder="Meeting agenda, topics to discuss..."
              rows="4"
            />
          </div>

          {/* Attendees */}
          <div className="form-group">
            <label>Attendees ({formData.attendees.length} selected)</label>
            <div className="attendees-list">
              {dealContacts.length === 0 ? (
                <p className="no-attendees">No contacts available. Please create contacts first.</p>
              ) : (
                dealContacts.map(contact => (
                  <label key={contact.id} className="attendee-checkbox">
                    <input
                      type="checkbox"
                      checked={formData.attendees.includes(contact.id)}
                      onChange={() => handleAttendeeToggle(contact.id)}
                    />
                    <span className="attendee-name">
                      {contact.first_name} {contact.last_name}
                      {contact.title && <span className="attendee-title"> • {contact.title}</span>}
                      {contact.account && <span className="attendee-company"> • {contact.account.name}</span>}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          {/* Submit Error */}
          {errors.submit && (
            <div className="error-banner">
              {errors.submit}
            </div>
          )}

          {/* Form Actions */}
          <div className="form-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving...' : (meeting ? 'Update Meeting' : 'Schedule Meeting')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default MeetingForm;
