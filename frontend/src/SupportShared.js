// SupportShared.js
// Shared constants, helpers, and primitive UI components for the Service module.
// Imported by: SupportView, CaseDetailPanel, CaseCreateModal

// ── Status / priority config ──────────────────────────────────────────────────

export const STATUS_CONFIG = {
  open:             { label: 'Open',             color: '#3b82f6', bg: '#dbeafe' },
  in_progress:      { label: 'In Progress',      color: '#8b5cf6', bg: '#ede9fe' },
  pending_customer: { label: 'Pending Customer', color: '#f59e0b', bg: '#fef3c7' },
  resolved:         { label: 'Resolved',         color: '#10b981', bg: '#d1fae5' },
  closed:           { label: 'Closed',           color: '#6b7280', bg: '#f3f4f6' },
};

export const PRIORITY_CONFIG = {
  low:      { label: 'Low',      color: '#6b7280', bg: '#f3f4f6' },
  medium:   { label: 'Medium',   color: '#3b82f6', bg: '#dbeafe' },
  high:     { label: 'High',     color: '#f59e0b', bg: '#fef3c7' },
  critical: { label: 'Critical', color: '#ef4444', bg: '#fee2e2' },
};

// Valid next transitions — mirrors supportService.js TRANSITIONS map
export const TRANSITIONS = {
  open:             ['in_progress'],
  in_progress:      ['pending_customer', 'resolved'],
  pending_customer: ['in_progress', 'resolved'],
  resolved:         ['closed', 'in_progress'],
  closed:           [],
};

// ── Shared UI components ──────────────────────────────────────────────────────

export function StatusBadge({ status, small }) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{
      display: 'inline-block',
      padding: small ? '2px 7px' : '3px 10px',
      borderRadius: 20,
      fontSize: small ? 11 : 12,
      fontWeight: 600,
      color: cfg.color,
      background: cfg.bg,
      whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

export function PriorityBadge({ priority, small }) {
  const cfg = PRIORITY_CONFIG[priority] || { label: priority, color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{
      display: 'inline-block',
      padding: small ? '2px 7px' : '3px 10px',
      borderRadius: 4,
      fontSize: small ? 11 : 12,
      fontWeight: 700,
      color: cfg.color,
      background: cfg.bg,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

export function SLATimer({ dueAt, breached, label }) {
  if (!dueAt) return null;
  const due     = new Date(dueAt);
  const now     = new Date();
  const diffMs  = due - now;
  const overdue = diffMs < 0;
  const absMs   = Math.abs(diffMs);
  const hours   = Math.floor(absMs / 3_600_000);
  const mins    = Math.floor((absMs % 3_600_000) / 60_000);
  const display = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  const color = breached || overdue ? '#ef4444' : diffMs < 3_600_000 ? '#f59e0b' : '#10b981';
  const bg    = breached || overdue ? '#fee2e2' : diffMs < 3_600_000 ? '#fef3c7' : '#d1fae5';

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 6,
      fontSize: 11, fontWeight: 600, color, background: bg,
    }}>
      {(breached || overdue) ? '⚡' : '⏱'}{label ? ` ${label}:` : ''} {overdue || breached ? `${display} overdue` : `${display} left`}
    </span>
  );
}

export function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        border: '3px solid #e5e7eb', borderTopColor: '#6366f1',
        animation: 'spin 0.7s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function EmptyState({ icon, title, desc, action, onAction }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: 10, color: '#94a3b8' }}>
      <div style={{ fontSize: 40 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#475569' }}>{title}</div>
      {desc && <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', maxWidth: 320 }}>{desc}</div>}
      {action && onAction && (
        <button onClick={onAction} style={{ marginTop: 8, padding: '8px 20px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {action}
        </button>
      )}
    </div>
  );
}

export function FormField({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}
