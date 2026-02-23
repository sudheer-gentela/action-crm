import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './AccountMergeBanner.css';

const MERGE_FIELDS = [
  { key: 'name',        label: 'Name' },
  { key: 'domain',      label: 'Domain' },
  { key: 'industry',    label: 'Industry' },
  { key: 'size',        label: 'Size' },
  { key: 'location',    label: 'Location' },
  { key: 'description', label: 'Description' },
];

export default function AccountMergeBanner({ onMergeComplete }) {
  const [groups, setGroups]           = useState([]);
  const [loading, setLoading]         = useState(true);
  const [dismissed, setDismissed]     = useState(false);
  const [activeGroup, setActiveGroup] = useState(null);
  const [merging, setMerging]         = useState(false);
  const [mergeError, setMergeError]   = useState('');
  const [mergeSuccess, setMergeSuccess] = useState('');
  const [fieldSelections, setFieldSelections] = useState({});

  const fetchDuplicates = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiService.accounts.getDuplicates();
      setGroups(res.data.duplicateGroups || []);
    } catch (err) {
      console.error('Failed to load account duplicates:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDuplicates(); }, [fetchDuplicates]);

  const startMerge = (group) => {
    setActiveGroup(group);
    setMergeError('');
    setMergeSuccess('');
    const defaults = {};
    MERGE_FIELDS.forEach(f => { defaults[f.key] = group.accounts[0].id; });
    setFieldSelections(defaults);
  };

  const cancelMerge = () => {
    setActiveGroup(null);
    setFieldSelections({});
    setMergeError('');
  };

  const executeMerge = async () => {
    if (!activeGroup || activeGroup.accounts.length < 2) return;
    setMerging(true);
    setMergeError('');

    const a1 = activeGroup.accounts[0];
    const a2 = activeGroup.accounts[1];

    let a1Wins = 0, a2Wins = 0;
    MERGE_FIELDS.forEach(f => {
      if (fieldSelections[f.key] === a1.id) a1Wins++;
      else a2Wins++;
    });

    const keepId   = a1Wins >= a2Wins ? a1.id : a2.id;
    const removeId = keepId === a1.id ? a2.id : a1.id;
    const removeAcct = keepId === a1.id ? a2 : a1;

    const fieldOverrides = {};
    MERGE_FIELDS.forEach(f => {
      if (fieldSelections[f.key] === removeAcct.id) {
        fieldOverrides[f.key] = 'from_remove';
      }
    });

    try {
      await apiService.accounts.merge(keepId, removeId, fieldOverrides);
      setMergeSuccess(`Merged successfully! Kept account #${keepId}, removed #${removeId}. All contacts and deals have been moved.`);
      setActiveGroup(null);
      setFieldSelections({});
      setGroups(prev => prev.filter(g => g !== activeGroup));
      if (onMergeComplete) onMergeComplete();
    } catch (err) {
      console.error('Account merge error:', err);
      setMergeError(err.response?.data?.error?.message || 'Merge failed. Please try again.');
    } finally {
      setMerging(false);
    }
  };

  if (loading || dismissed || (groups.length === 0 && !mergeSuccess)) return null;

  return (
    <div className="amb-root">
      {mergeSuccess && (
        <div className="amb-success">
          ✅ {mergeSuccess}
          <button className="amb-success-dismiss" onClick={() => setMergeSuccess('')}>✕</button>
        </div>
      )}

      {groups.length > 0 && !activeGroup && (
        <div className="amb-banner">
          <div className="amb-banner-left">
            <span className="amb-banner-icon">⚠️</span>
            <div className="amb-banner-text">
              <strong>{groups.length} duplicate account{groups.length !== 1 ? ' groups' : ''} found</strong>
              <span className="amb-banner-sub">
                Accounts with the same name or domain. Merge them to consolidate deals and contacts.
              </span>
            </div>
          </div>
          <div className="amb-banner-actions">
            <button className="amb-btn amb-btn--review" onClick={() => startMerge(groups[0])}>
              Review & Merge
            </button>
            <button className="amb-btn amb-btn--dismiss" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {activeGroup && (
        <div className="amb-merge-panel">
          <div className="amb-merge-header">
            <h3>Merge Duplicate Accounts</h3>
            <span className="amb-merge-hint">
              Pick which value to keep for each field. All contacts and deals from the removed account will be moved to the keeper.
            </span>
          </div>

          {mergeError && <div className="amb-error">{mergeError}</div>}

          <div className="amb-compare">
            <div className="amb-compare-row amb-compare-row--header">
              <div className="amb-compare-label">Field</div>
              {activeGroup.accounts.slice(0, 2).map(a => (
                <div key={a.id} className="amb-compare-cell amb-compare-cell--header">
                  <div className="amb-acct-id">Account #{a.id}</div>
                  <div className="amb-acct-name">{a.name}</div>
                  {a.domain && <div className="amb-acct-domain">{a.domain}</div>}
                  <div className="amb-acct-created">Created {new Date(a.created_at).toLocaleDateString()}</div>
                </div>
              ))}
            </div>

            {MERGE_FIELDS.map(field => {
              const a1 = activeGroup.accounts[0];
              const a2 = activeGroup.accounts[1];
              const v1 = a1[field.key] || '';
              const v2 = a2[field.key] || '';
              const isDifferent = String(v1) !== String(v2);
              const selectedId = fieldSelections[field.key];

              return (
                <div key={field.key} className={`amb-compare-row ${isDifferent ? 'amb-compare-row--conflict' : ''}`}>
                  <div className="amb-compare-label">{field.label}</div>
                  {[a1, a2].map(a => {
                    const val = a[field.key] || '';
                    const isSelected = selectedId === a.id;
                    return (
                      <div
                        key={a.id}
                        className={`amb-compare-cell ${isSelected ? 'amb-compare-cell--selected' : ''} ${isDifferent ? 'amb-compare-cell--clickable' : ''}`}
                        onClick={() => {
                          if (isDifferent) setFieldSelections(prev => ({ ...prev, [field.key]: a.id }));
                        }}
                      >
                        <span className="amb-cell-value">{String(val) || '—'}</span>
                        {isDifferent && isSelected && <span className="amb-cell-check">✓</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {groups.length > 1 && (
            <div className="amb-group-nav">
              {groups.map((g, i) => (
                <button
                  key={i}
                  className={`amb-group-dot ${g === activeGroup ? 'amb-group-dot--active' : ''}`}
                  onClick={() => startMerge(g)}
                  title={`Group ${i + 1}: ${g.accounts.map(a => a.name).join(' & ')}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}

          <div className="amb-merge-actions">
            <button className="amb-btn amb-btn--cancel" onClick={cancelMerge}>Cancel</button>
            <button className="amb-btn amb-btn--merge" onClick={executeMerge} disabled={merging}>
              {merging ? 'Merging…' : '🔗 Merge Accounts'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
