// ============================================================
// ActionCRM Playbook Builder — D3: ActionsView Integration
// File: frontend/src/EnrichedActionCard.js
//
// HOW TO USE — in ActionsView.js:
//
//   import { EnrichedActionCard, CHANNEL_CONFIG } from './EnrichedActionCard';
//
//   Add these two handlers inside your ActionsView component:
//
//   const handleMarkDone = async (action) => {
//     try {
//       // actions.status CHECK: 'yet_to_start'|'in_progress'|'completed'|'snoozed'
//       await apiService.patch(`/api/actions/${action.id}`, {
//         status: 'completed',
//         completed: true,
//         completed_at: new Date().toISOString(),
//         completed_by: currentUser.id,
//       });
//       // Update the play instance too if this action came from a play
//       if (action.play_instance_id) {
//         await apiService.patch(
//           `/api/deal-play-instances/${action.play_instance_id}`,
//           { status: 'completed', completed_at: new Date().toISOString() }
//         );
//       }
//       loadActions();
//     } catch (err) {
//       console.error('Failed to mark action done', err);
//     }
//   };
//
//   const handleSkip = async (action) => {
//     try {
//       // 'skipped' is NOT a valid actions.status value.
//       // Use 'completed' with auto_completed=true, OR mark as snoozed,
//       // depending on your product definition. Here we use snoozed
//       // with a far-future date as the pragmatic equivalent of "dismissed".
//       // Change this to match however your existing ActionsView dismisses actions.
//       await apiService.patch(`/api/actions/${action.id}`, {
//         status: 'snoozed',
//         snoozed_until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
//         snooze_reason: 'Skipped by user',
//         snooze_duration: '1y',
//       });
//       loadActions();
//     } catch (err) {
//       console.error('Failed to skip action', err);
//     }
//   };
//
//   Then in your action list render:
//   {actions.map(action => (
//     <EnrichedActionCard
//       key={action.id}
//       action={action}
//       onMarkDone={handleMarkDone}
//       onSkip={handleSkip}
//     />
//   ))}
//
// NEW FIELDS on the action object (from PlaybookActionGenerator / actions table):
//   action.channel          — matches CHANNEL_CONFIG keys
//   action.playbook_id      — FK to playbooks (already on actions table)
//   action.playbook_name    — VARCHAR(255) already on actions table
//   action.playbook_play_id — FK to playbook_plays (already on actions table)
//   action.suggested_action — text (already on actions table)
//   action.deal_stage       — VARCHAR(50) (already on actions table)
//   action.deal_id          — for linking back to the deal
//   action.priority         — 'high'|'medium'|'low' (actions.priority is VARCHAR(20))
//   action.due_date         — timestamp
//   action.status           — 'yet_to_start'|'in_progress'|'completed'|'snoozed'
//
// play_instance_id comes from deal_play_instances.id, joined when fetching actions.
// You can add it via: LEFT JOIN deal_play_instances dpi ON dpi.action_id = actions.id
// ============================================================

import React from 'react';
import './EnrichedActionCard.css';

export const CHANNEL_CONFIG = {
  email:    { icon: '✉️', color: '#3b82f6', label: 'Email' },
  call:     { icon: '📞', color: '#10b981', label: 'Call' },
  meeting:  { icon: '🗓️', color: '#8b5cf6', label: 'Meeting' },
  task:     { icon: '✅', color: '#f59e0b', label: 'Task' },
  document: { icon: '📄', color: '#6366f1', label: 'Document' },
  slack:    { icon: '💬', color: '#ec4899', label: 'Slack' },
  crm:      { icon: '🗂️', color: '#ef4444', label: 'CRM Update' },
  sms:      { icon: '📱', color: '#14b8a6', label: 'SMS' },
};

const FALLBACK_CHANNEL = { icon: '⚡', color: '#6b7280', label: 'Action' };

// Map the existing actions.priority values to display labels
const PRIORITY_CONFIG = {
  high:   { label: 'High priority', cls: 'priority-chip--high' },
  medium: null,   // don't show a badge for medium — it's the default
  low:    { label: 'Low priority',  cls: 'priority-chip--low' },
};

export function EnrichedActionCard({ action, onMarkDone, onSkip }) {
  const ch = CHANNEL_CONFIG[action.channel] || FALLBACK_CHANNEL;
  const priorityBadge = PRIORITY_CONFIG[action.priority];
  const isDone = action.status === 'completed';
  const isSnoozed = action.status === 'snoozed';

  return (
    <div
      className={`action-card action-card--enriched ${isDone ? 'action-card--done' : ''}`}
      style={{ borderLeft: `4px solid ${ch.color}` }}
    >
      {/* Channel + priority row */}
      <div className="action-card-channel">
        <span className="action-channel-icon" aria-hidden="true">{ch.icon}</span>
        <span className="action-channel-label" style={{ color: ch.color }}>
          {ch.label}
        </span>
        {priorityBadge && (
          <span className={`priority-chip ${priorityBadge.cls}`}>
            {priorityBadge.label}
          </span>
        )}
        {isSnoozed && (
          <span className="priority-chip priority-chip--snoozed">Snoozed</span>
        )}
      </div>

      {/* Entity context — deal name + stage */}
      {(action.entity_name || action.deal_stage) && (
        <div className="action-card-entity">
          {action.entity_name && (
            <span className="action-entity-name">{action.entity_name}</span>
          )}
          {action.deal_stage && (
            <span className="action-entity-stage"> · {action.deal_stage}</span>
          )}
        </div>
      )}

      {/* Main content */}
      <div className="action-card-body">
        <p className="action-title">{action.title}</p>
        {action.suggested_action && (
          <p className="action-suggested">{action.suggested_action}</p>
        )}
        {action.description && !action.suggested_action && (
          <p className="action-suggested">{action.description}</p>
        )}
      </div>

      {/* Meta row */}
      <div className="action-card-meta">
        {action.due_date && (
          <span className="action-due">
            Due {new Date(action.due_date).toLocaleDateString()}
          </span>
        )}
        {action.playbook_name && (
          <span className="action-source">{action.playbook_name}</span>
        )}
      </div>

      {/* Action buttons — hidden when already completed */}
      {!isDone && (
        <div className="action-card-actions">
          <button
            className="btn-done"
            onClick={() => onMarkDone(action)}
            type="button"
          >
            ✓ Done
          </button>
          <button
            className="btn-skip"
            onClick={() => onSkip(action)}
            type="button"
          >
            Skip
          </button>
        </div>
      )}

      {isDone && (
        <div className="action-card-completed-badge">Completed</div>
      )}
    </div>
  );
}
