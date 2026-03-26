import { apiService } from './apiService';
// ============================================================
// ActionCRM Playbook Builder — C2: PlaybookDetail (full-page)
// File: frontend/src/PlaybookDetail.js
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';

import PlayEditor from './PlayEditor';
import AccessManagement from './AccessManagement';
import ArchiveModal from './ArchiveModal';
import './PlaybookDetail.css';

// ─── Constants defined once at module scope ───────────────────
const CHANNEL_ICONS = {
  email: '✉️',
  call: '📞',
  meeting: '🗓️',
  task: '✅',
  document: '📄',
  slack: '💬',
  crm: '🗂️',
  sms: '📱',
  default: '⚡',
};

const CHANNEL_COLORS = {
  email: '#3b82f6',
  call: '#10b981',
  meeting: '#8b5cf6',
  task: '#f59e0b',
  document: '#6366f1',
  slack: '#ec4899',
  crm: '#ef4444',
  sms: '#14b8a6',
};

const TABS = [
  { key: 'stages', label: 'Stages & Plays' },
  { key: 'routing', label: 'Routing & Roles' },
  { key: 'settings', label: 'Settings' },
  { key: 'activity', label: 'Activity Log' },
];

// ─── Main component ───────────────────────────────────────────
export default function PlaybookDetail({ playbookId, onBack, currentUser }) {
  const id = playbookId;
  const navigate = (path) => {
    if (onBack) onBack();
    else window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'playbooks' } }));
  };

  const [playbook, setPlaybook] = useState(null);
  const [access, setAccess] = useState(null); // 'owner' | 'reader' | null
  const [plays, setPlays] = useState([]);
  const [versions, setVersions] = useState([]);
  const [activeTab, setActiveTab] = useState('stages');
  const [activeStage, setActiveStage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editingPlay, setEditingPlay] = useState(null); // null | 'new' | play object
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const isAdmin = currentUser?.role === 'org_admin';
  const canEdit = access === 'owner';

  const load = useCallback(async () => {
    if (!id) return; // guard: don't fetch if id is null/undefined
    setLoading(true);
    try {
      const [pbRes, vRes] = await Promise.all([
        apiService.playbookBuilder.getById(id),
        apiService.playbookBuilder.getVersions(id),
      ]);
      // Handle both route shapes:
      // builder route: { playbook, access }
      // old route:     { playbook } (no access field)
      const pb = pbRes?.playbook ?? pbRes;
      const resolvedAccess = pbRes?.access ?? 'reader';
      setPlaybook(pb || null);
      setAccess(resolvedAccess);
      setVersions(vRes?.versions || []);
      if (pb?.stages?.length) {
        setActiveStage(pb.stages[0]);
      }
    } catch (err) {
      console.error('Failed to load playbook', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadPlays = useCallback(
    async (stage_key) => {
      if (!stage_key) return;
      try {
        const res = await apiService.playbookBuilder.getPlays(id, { stage_key });
        setPlays(res.plays || []);
      } catch (err) {
        console.error('Failed to load plays', err);
      }
    },
    [id]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (activeStage) loadPlays(activeStage.stage_key);
  }, [activeStage, loadPlays]);

  const handleStageClick = (stage) => {
    setActiveStage(stage);
    setEditingPlay(null);
  };

  const handleNewDraftVersion = async () => {
    if (!window.confirm('Create a new draft version from the current live version?')) return;
    setSaving(true);
    try {
      await apiService.playbookBuilder.createVersion(id, { change_summary: '' });
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmitVersion = async () => {
    const draft = versions.find((v) => v.status === 'draft');
    if (!draft) return alert('No draft version to submit.');
    if (!window.confirm('Submit this draft for approval?')) return;
    setSaving(true);
    try {
      await apiService.playbookBuilder.submitVersion(id, draft.version_number);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (archiveData) => {
    setSaving(true);
    try {
      await apiService.playbookBuilder.archive(id, archiveData);
      setShowArchiveModal(false);
      navigate('/playbooks');
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handlePlaySaved = useCallback(async () => {
    setEditingPlay(null);
    if (activeStage?.stage_key) await loadPlays(activeStage.stage_key);
    await load();
  }, [activeStage, loadPlays, load]);

  const handlePlayDeleted = useCallback(async () => {
    if (activeStage?.stage_key) await loadPlays(activeStage.stage_key);
    await load();
  }, [activeStage, loadPlays, load]);

  if (loading) return <div className="pb-detail-loading">Loading playbook…</div>;
  if (!id) return <div className="pb-detail-error">No playbook selected. <button onClick={() => navigate('/playbooks')} style={{background:'none',border:'none',color:'#0F9D8E',cursor:'pointer',textDecoration:'underline'}}>Go back</button></div>;
  if (!playbook) return <div className="pb-detail-error">Playbook not found. <button onClick={() => navigate('/playbooks')} style={{background:'none',border:'none',color:'#0F9D8E',cursor:'pointer',textDecoration:'underline'}}>Go back</button></div>;

  const liveVersion = versions.find((v) => v.status === 'live');
  const draftVersion = versions.find((v) => v.status === 'draft');
  const reviewVersion = versions.find((v) => v.status === 'under_review');

  return (
    <div className="pb-detail">
      {/* Breadcrumb */}
      <nav className="pb-breadcrumb">
        <button onClick={() => navigate('/playbooks')} style={{ background:'none', border:'none', color:'#0F9D8E', cursor:'pointer', padding:0, fontSize:'inherit' }}>Playbooks</button>
        <span className="pb-breadcrumb-sep">›</span>
        <span>{playbook.name}</span>
      </nav>

      {/* Header */}
      <div className="pb-detail-header">
        <div className="pb-detail-title-block">
          <h1>{playbook.name}</h1>
          <div className="pb-detail-meta">
            <span className="pb-type-chip">{playbook.type}</span>
            {playbook.department && (
              <span className="pb-dept-chip">{playbook.department}</span>
            )}
            {!playbook.is_active && (
              <span className="pb-badge badge-archived">Archived</span>
            )}
          </div>
        </div>

        <div className="pb-detail-header-actions">
          <VersionBar
            liveVersion={liveVersion}
            draftVersion={draftVersion}
            reviewVersion={reviewVersion}
            canEdit={canEdit}
            isAdmin={isAdmin}
            onNewDraft={handleNewDraftVersion}
            onSubmit={handleSubmitVersion}
            saving={saving}
          />
          {isAdmin && playbook.is_active && (
            <div className="pb-header-btns">
              <button
                className="btn-danger-outline"
                onClick={() => setShowArchiveModal(true)}
              >
                Archive
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="pb-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`pb-tab ${activeTab === tab.key ? 'pb-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab: Stages & Plays */}
      {activeTab === 'stages' && (
        <div className="pb-stages-layout">
          <div className="pb-pipeline-area">
            <StagePipeline
              stages={playbook.stages || []}
              activeStage={activeStage}
              onStageClick={handleStageClick}
            />
          </div>

          {activeStage && (
            <div className="pb-stage-sidebar">
              <StageInfoSidebar stage={activeStage} />
            </div>
          )}

          <div className="pb-plays-area">
            {activeStage ? (
              <>
                <div className="pb-plays-header">
                  <h3>Plays — {activeStage.name}</h3>
                  {canEdit && (
                    <button
                      className="btn-primary btn-sm"
                      onClick={() => setEditingPlay('new')}
                    >
                      + Add Play
                    </button>
                  )}
                </div>

                {editingPlay && (
                  <PlayEditor
                    playbook_id={id}
                    org_id={playbook.org_id}
                    stage_key={activeStage.stage_key}
                    play={editingPlay === 'new' ? null : editingPlay}
                    onSave={handlePlaySaved}
                    onCancel={() => setEditingPlay(null)}
                  />
                )}

                <PlaysList
                  plays={plays}
                  canEdit={canEdit}
                  onEdit={(play) => setEditingPlay(play)}
                  playbook_id={id}
                  onRefresh={handlePlayDeleted}
                />
              </>
            ) : (
              <div className="pb-plays-empty">
                Select a stage to view its plays.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab: Routing & Roles */}
      {activeTab === 'routing' && (
        <div className="pb-routing-tab">
          <h3>Routing & Roles</h3>
          <div className="pb-info-grid">
            <div className="pb-info-row">
              <span className="pb-info-label">Entity type</span>
              <span className="pb-info-value">{playbook.entity_type || '—'}</span>
            </div>
            <div className="pb-info-row">
              <span className="pb-info-label">Trigger mode</span>
              <span className="pb-info-value">{playbook.trigger_mode || '—'}</span>
            </div>
            <div className="pb-info-row">
              <span className="pb-info-label">Conflict rule</span>
              <span className="pb-info-value">{playbook.conflict_rule || '—'}</span>
            </div>
            <div className="pb-info-row">
              <span className="pb-info-label">Eligibility filter</span>
              <code className="pb-info-value">
                {playbook.eligibility_filter || 'None'}
              </code>
            </div>
          </div>
          {isAdmin && <AccessManagement playbook_id={id} isAdmin={isAdmin} />}
        </div>
      )}

      {/* Tab: Settings */}
      {activeTab === 'settings' && (
        <PlaybookSettings
          playbook={playbook}
          canEdit={canEdit}
          onSaved={load}
        />
      )}

      {/* Tab: Activity Log */}
      {activeTab === 'activity' && (
        <ActivityLog versions={versions} playbook={playbook} />
      )}

      {/* Archive Modal */}
      {showArchiveModal && (
        <ArchiveModal
          playbook={playbook}
          onConfirm={handleArchive}
          onCancel={() => setShowArchiveModal(false)}
        />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────

function VersionBar({
  liveVersion,
  draftVersion,
  reviewVersion,
  canEdit,
  isAdmin,
  onNewDraft,
  onSubmit,
  saving,
}) {
  return (
    <div className="version-bar">
      {liveVersion && (
        <span className="version-chip version-chip--live">
          v{liveVersion.version_number} Live
        </span>
      )}
      {draftVersion && (
        <span className="version-chip version-chip--draft">
          v{draftVersion.version_number} Draft
        </span>
      )}
      {reviewVersion && (
        <span className="version-chip version-chip--review">
          v{reviewVersion.version_number} Under Review
        </span>
      )}
      {canEdit && !draftVersion && !reviewVersion && liveVersion && (
        <button
          className="btn-secondary btn-sm"
          onClick={onNewDraft}
          disabled={saving}
        >
          New Version
        </button>
      )}
      {canEdit && draftVersion && (
        <button
          className="btn-primary btn-sm"
          onClick={onSubmit}
          disabled={saving}
        >
          Submit for Approval
        </button>
      )}
      {isAdmin && reviewVersion && (
        <span className="version-chip version-chip--action">
          Review pending →
        </span>
      )}
    </div>
  );
}

function StagePipeline({ stages, activeStage, onStageClick }) {
  return (
    <div className="stage-pipeline">
      {stages.map((stage, i) => (
        <React.Fragment key={stage.id}>
          <div
            className={`stage-node ${
              activeStage?.id === stage.id ? 'stage-node--active' : ''
            }`}
            onClick={() => onStageClick(stage)}
          >
            <div className="stage-node-name">{stage.name}</div>
            <div className="stage-node-count">
              {stage.play_count}{' '}
              {Number(stage.play_count) === 1 ? 'play' : 'plays'}
            </div>
          </div>
          {i < stages.length - 1 && (
            <div className="stage-connector">→</div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function StageInfoSidebar({ stage }) {
  return (
    <div className="stage-info-sidebar">
      <h4>{stage.name}</h4>
      {stage.goal && (
        <div className="stage-info-section">
          <label>Goal</label>
          <p>{stage.goal}</p>
        </div>
      )}
      {stage.entry_criteria && (
        <div className="stage-info-section">
          <label>Entry Criteria</label>
          <p>{stage.entry_criteria}</p>
        </div>
      )}
      {stage.exit_criteria && (
        <div className="stage-info-section">
          <label>Exit Criteria</label>
          <p>{stage.exit_criteria}</p>
        </div>
      )}
    </div>
  );
}

function PlaysList({ plays, canEdit, onEdit, playbook_id, onRefresh }) {
  const handleDelete = async (play) => {
    if (!window.confirm(`Delete play "${play.title}"?`)) return;
    try {
      await apiService.playbookBuilder.deletePlay(playbook_id, play.id);
      onRefresh();
    } catch (err) {
      alert(err.message);
    }
  };

  if (!plays.length) {
    return <div className="plays-empty">No plays in this stage yet.</div>;
  }

  return (
    <div className="plays-list">
      {plays.map((play) => (
        <div key={play.id} className="play-card">
          <div
            className="play-card-channel-bar"
            style={{ background: CHANNEL_COLORS[play.channel] || '#6b7280' }}
          />
          <div className="play-card-body">
            <div className="play-card-header">
              <span className="play-channel-icon">
                {CHANNEL_ICONS[play.channel] || CHANNEL_ICONS.default}
              </span>
              <span className="play-title">{play.title}</span>
              <div className="play-badges">
                <span className="play-badge">
                  {play.trigger_mode || 'stage_change'}
                </span>
                <span className="play-badge">
                  {play.generation_mode || 'template'}
                </span>
                {play.fire_conditions && (
                  <span className="play-badge badge-condition">
                    Conditional
                  </span>
                )}
              </div>
            </div>
            {play.description && (
              <p className="play-description">{play.description}</p>
            )}
            {play.suggested_action && (
              <p className="play-suggested">
                <strong>Suggested:</strong> {play.suggested_action}
              </p>
            )}
            <div className="play-meta">
              <span>Priority: {play.priority}</span>
              {play.role_name && <span>Role: {play.role_name}</span>}
            </div>
          </div>
          {canEdit && (
            <div className="play-card-actions">
              <button
                className="btn-icon"
                onClick={() => onEdit(play)}
                title="Edit"
              >
                ✏️
              </button>
              <button
                className="btn-icon btn-icon--danger"
                onClick={() => handleDelete(play)}
                title="Delete"
              >
                🗑
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PlaybookSettings({ playbook, canEdit, onSaved }) {
  const [form, setForm] = useState({
    name: playbook.name || '',
    description: playbook.description || '',
    department: playbook.department || '',
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiService.playbookBuilder.update(playbook.id, form);
      onSaved();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pb-settings-tab">
      <h3>Playbook Settings</h3>
      <div className="pb-settings-form">
        <label>
          Name
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            disabled={!canEdit}
          />
        </label>
        <label>
          Description
          <textarea
            value={form.description}
            onChange={(e) =>
              setForm((f) => ({ ...f, description: e.target.value }))
            }
            disabled={!canEdit}
            rows={4}
          />
        </label>
        <label>
          Department
          <input
            type="text"
            value={form.department}
            onChange={(e) =>
              setForm((f) => ({ ...f, department: e.target.value }))
            }
            disabled={!canEdit}
          />
        </label>
        {canEdit && (
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        )}
      </div>
    </div>
  );
}

function ActivityLog({ versions, playbook }) {
  const events = [
    ...(versions || []).map((v) => ({
      date: v.published_at || v.created_at,
      label: v.published_at
        ? `v${v.version_number} published`
        : `v${v.version_number} created (${v.status})`,
      by: v.created_by_name || v.approved_by_name || null,
    })),
    ...(playbook.archived_at
      ? [
          {
            date: playbook.archived_at,
            label: `Archived — ${playbook.archive_reason || 'No reason given'}`,
            by: null,
          },
        ]
      : []),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div className="pb-activity-tab">
      <h3>Activity Log</h3>
      {events.length === 0 && (
        <p className="activity-empty">No activity recorded yet.</p>
      )}
      <div className="activity-timeline">
        {events.map((e, i) => (
          <div key={i} className="activity-event">
            <div className="activity-dot" />
            <div className="activity-content">
              <p className="activity-label">{e.label}</p>
              <p className="activity-meta">
                {e.by && <span>{e.by} · </span>}
                {new Date(e.date).toLocaleDateString()}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
