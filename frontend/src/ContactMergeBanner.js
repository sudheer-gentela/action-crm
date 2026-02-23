import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './ContactMergeBanner.css';

/**
 * ContactMergeBanner
 *
 * Sits at the top of ContactsView. Checks for duplicate contact groups
 * and provides an inline merge UI with field-by-field selection.
 *
 * Props:
 *   onMergeComplete {function} — called after a successful merge so the parent can reload contacts
 */
export default function ContactMergeBanner({ onMergeComplete }) {
  const [groups, setGroups]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [dismissed, setDismissed]   = useState(false);
  const [activeGroup, setActiveGroup] = useState(null); // the group being merged
  const [merging, setMerging]       = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [mergeSuccess, setMergeSuccess] = useState('');

  // Field selection: { fieldName: contactId } — which contact to take each field from
  const [fieldSelections, setFieldSelections] = useState({});

  const fetchDuplicates = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiService.contacts.getDuplicates();
      setGroups(res.data.duplicateGroups || []);
    } catch (err) {
      console.error('Failed to load duplicates:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDuplicates(); }, [fetchDuplicates]);

  // When a group is selected for merge, initialize field selections
  const startMerge = (group) => {
    setActiveGroup(group);
    setMergeError('');
    setMergeSuccess('');
    // Default: keep all fields from the first (oldest) contact
    const defaults = {};
    MERGE_FIELDS.forEach(f => {
      defaults[f.key] = group.contacts[0].id;
    });
    setFieldSelections(defaults);
  };

  const cancelMerge = () => {
    setActiveGroup(null);
    setFieldSelections({});
    setMergeError('');
  };

  const executeMerge = async () => {
    if (!activeGroup || activeGroup.contacts.length < 2) return;
    setMerging(true);
    setMergeError('');

    // Determine keeper (most-selected contact) and build overrides
    const c1 = activeGroup.contacts[0];
    const c2 = activeGroup.contacts[1];

    // Count which contact "wins" more fields to decide keeper
    let c1Wins = 0, c2Wins = 0;
    MERGE_FIELDS.forEach(f => {
      if (fieldSelections[f.key] === c1.id) c1Wins++;
      else c2Wins++;
    });

    const keepId   = c1Wins >= c2Wins ? c1.id : c2.id;
    const removeId = keepId === c1.id ? c2.id : c1.id;
    const removeContact = keepId === c1.id ? c2 : c1;

    // Build fieldOverrides — fields where we want the removed contact's value
    const fieldOverrides = {};
    MERGE_FIELDS.forEach(f => {
      if (fieldSelections[f.key] === removeContact.id) {
        fieldOverrides[f.key] = 'from_remove';
      }
    });

    try {
      await apiService.contacts.merge(keepId, removeId, fieldOverrides);
      setMergeSuccess(`Merged successfully! Kept contact #${keepId}, removed #${removeId}.`);
      setActiveGroup(null);
      setFieldSelections({});
      // Remove this group from the list
      setGroups(prev => prev.filter(g => g !== activeGroup));
      if (onMergeComplete) onMergeComplete();
    } catch (err) {
      console.error('Merge error:', err);
      setMergeError(err.response?.data?.error?.message || 'Merge failed. Please try again.');
    } finally {
      setMerging(false);
    }
  };

  // Nothing to show
  if (loading || dismissed || (groups.length === 0 && !mergeSuccess)) return null;

  return (
    <div className="cmb-root">
      {/* Success message */}
      {mergeSuccess && (
        <div className="cmb-success">
          ✅ {mergeSuccess}
          <button className="cmb-success-dismiss" onClick={() => setMergeSuccess('')}>✕</button>
        </div>
      )}

      {/* Banner when there are duplicate groups but no active merge */}
      {groups.length > 0 && !activeGroup && (
        <div className="cmb-banner">
          <div className="cmb-banner-left">
            <span className="cmb-banner-icon">⚠️</span>
            <div className="cmb-banner-text">
              <strong>{groups.length} duplicate contact{groups.length !== 1 ? ' groups' : ''} found</strong>
              <span className="cmb-banner-sub">
                Contacts with the same email or name on the same account. Review and merge to keep your CRM clean.
              </span>
            </div>
          </div>
          <div className="cmb-banner-actions">
            <button className="cmb-btn cmb-btn--review" onClick={() => startMerge(groups[0])}>
              Review & Merge
            </button>
            <button className="cmb-btn cmb-btn--dismiss" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Active merge UI */}
      {activeGroup && (
        <div className="cmb-merge-panel">
          <div className="cmb-merge-header">
            <h3>Merge Duplicate Contacts</h3>
            <span className="cmb-merge-hint">
              For each field, pick which contact's value to keep. All relationships (deals, emails, meetings) will be combined.
            </span>
          </div>

          {mergeError && <div className="cmb-error">{mergeError}</div>}

          {/* Contact comparison table */}
          <div className="cmb-compare">
            {/* Header row */}
            <div className="cmb-compare-row cmb-compare-row--header">
              <div className="cmb-compare-label">Field</div>
              {activeGroup.contacts.slice(0, 2).map((c, i) => (
                <div key={c.id} className="cmb-compare-cell cmb-compare-cell--header">
                  <div className="cmb-contact-id">Contact #{c.id}</div>
                  <div className="cmb-contact-name">{c.first_name} {c.last_name}</div>
                  {c.account_name && <div className="cmb-contact-account">{c.account_name}</div>}
                  <div className="cmb-contact-created">Created {new Date(c.created_at).toLocaleDateString()}</div>
                </div>
              ))}
            </div>

            {/* Field rows */}
            {MERGE_FIELDS.map(field => {
              const c1 = activeGroup.contacts[0];
              const c2 = activeGroup.contacts[1];
              const v1 = c1[field.key] || '';
              const v2 = c2[field.key] || '';
              const isDifferent = v1 !== v2;
              const selectedId = fieldSelections[field.key];

              return (
                <div
                  key={field.key}
                  className={`cmb-compare-row ${isDifferent ? 'cmb-compare-row--conflict' : ''}`}
                >
                  <div className="cmb-compare-label">{field.label}</div>
                  {[c1, c2].map(c => {
                    const val = c[field.key] || '';
                    const isSelected = selectedId === c.id;
                    return (
                      <div
                        key={c.id}
                        className={`cmb-compare-cell ${isSelected ? 'cmb-compare-cell--selected' : ''} ${isDifferent ? 'cmb-compare-cell--clickable' : ''}`}
                        onClick={() => {
                          if (isDifferent) {
                            setFieldSelections(prev => ({ ...prev, [field.key]: c.id }));
                          }
                        }}
                      >
                        <span className="cmb-cell-value">{val || '—'}</span>
                        {isDifferent && isSelected && <span className="cmb-cell-check">✓</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Navigation between groups */}
          {groups.length > 1 && (
            <div className="cmb-group-nav">
              {groups.map((g, i) => (
                <button
                  key={i}
                  className={`cmb-group-dot ${g === activeGroup ? 'cmb-group-dot--active' : ''}`}
                  onClick={() => startMerge(g)}
                  title={`Group ${i + 1}: ${g.contacts.map(c => c.first_name).join(' & ')}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="cmb-merge-actions">
            <button className="cmb-btn cmb-btn--cancel" onClick={cancelMerge}>
              Cancel
            </button>
            <button
              className="cmb-btn cmb-btn--merge"
              onClick={executeMerge}
              disabled={merging}
            >
              {merging ? 'Merging…' : '🔗 Merge Contacts'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Fields available for field-level merge selection
const MERGE_FIELDS = [
  { key: 'first_name',       label: 'First Name' },
  { key: 'last_name',        label: 'Last Name' },
  { key: 'email',            label: 'Email' },
  { key: 'phone',            label: 'Phone' },
  { key: 'title',            label: 'Job Title' },
  { key: 'role_type',        label: 'Role Type' },
  { key: 'engagement_level', label: 'Engagement' },
  { key: 'location',         label: 'Location' },
  { key: 'linkedin_url',     label: 'LinkedIn' },
  { key: 'notes',            label: 'Notes' },
];
