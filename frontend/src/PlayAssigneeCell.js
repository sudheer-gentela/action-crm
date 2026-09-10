// PlayAssigneeCell.js
//
// Who is assigned to one project task, on the checklist row: the chip group and
// the picker behind it.
//
// ── ONE OWNER, SEVERAL ASSIGNEES ─────────────────────────────────────
//
// The owner (project_play_instances.owner_user_id) keeps every meaning it had —
// accountable, submits for review, the single recipient of dependency and
// review notifications. It is still edited by the InlineCell beside this one.
// This component owns the OTHER thing: everyone who works on the task and may
// log daily work against it.
//
// The owner always appears here too, first and starred, because
// trg_sync_play_owner_assignee (2026_141) guarantees they have a row. They
// cannot be unticked — the server refuses it in setAssignees and the database
// refuses it again in trg_protect_play_owner_assignee, so offering the tick
// would be offering something two layers below will reject.
//
// ── THE MEMBER LIST IS THE PROJECT'S, NOT THE ORG'S ──────────────────
//
// Fed by GET /assignable-members — project_members with status 'approved' and
// exited_at IS NULL. NOT the `users` array HandoverView keeps for the owner
// picker, which it declares as "org members for owner pickers" and which holds
// the whole org.
//
// That difference is the point. dailyWork's _canLogAgainstTask delegates to
// handover.getNoteVisibility, which requires membership or a management
// relationship, so a non-member assigned here would get the task on their My
// day and then be refused at the composer. Showing only people who can actually
// do the work is what stops that.
//
// ── STYLING ──────────────────────────────────────────────────────────
//
// Inline styles rather than classes, for the same reason TaskWorkComposer uses
// them: this renders inside HandoverView, which loads no daily-work stylesheet.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiService } from './apiService';

const MAX_CHIPS = 2;

function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

/**
 * The chips, collapsed.
 *
 * Two names then "+N" rather than every name. A task with six people on it
 * would otherwise make its row three times the height of its neighbours, and
 * the checklist is read by scanning down the title column.
 */
function Chips({ assignees, onOpen, canEdit }) {
  if (!assignees.length) {
    return (
      <button
        type="button"
        onClick={canEdit ? onOpen : undefined}
        disabled={!canEdit}
        style={{
          background: 'none', border: 'none', padding: 0, font: 'inherit',
          fontSize: 11, color: '#9ca3af',
          cursor: canEdit ? 'pointer' : 'default',
        }}>
        {canEdit ? 'Assign' : 'Unassigned'}
      </button>
    );
  }

  const shown = assignees.slice(0, MAX_CHIPS);
  const rest  = assignees.length - shown.length;

  return (
    <button
      type="button"
      onClick={canEdit ? onOpen : undefined}
      disabled={!canEdit}
      title={assignees.map(a => a.name + (a.isOwner ? ' (owner)' : '')).join(', ')}
      style={{
        background: 'none', border: 'none', padding: 0, font: 'inherit',
        display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
        cursor: canEdit ? 'pointer' : 'default', textAlign: 'left',
      }}>
      {shown.map(a => (
        <span key={a.userId}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontSize: 11, padding: '1px 7px', borderRadius: 10,
            whiteSpace: 'nowrap',
            background: a.isOwner ? '#eff6ff' : '#f3f4f6',
            color:      a.isOwner ? '#1d4ed8' : '#4b5563',
          }}>
          {/* The owner is marked, not separated. A second column for "owner"
              and "others" makes the row wider to say something one glyph
              already says. */}
          {a.isOwner && <span aria-label="owner" title="Owner">★</span>}
          {a.name || `#${a.userId}`}
        </span>
      ))}
      {rest > 0 && (
        <span style={{
          fontSize: 11, padding: '1px 7px', borderRadius: 10,
          background: '#f3f4f6', color: '#6b7280',
        }}>+{rest}</span>
      )}
    </button>
  );
}

/**
 * The picker.
 *
 * ── WHY THE SAVE IS ONE CALL, NOT ONE PER TICK ───────────────────────
 *
 * setAssignees REPLACES the list in a single transaction. Ticking three boxes
 * and untickinging one is one intention, and sending it as four calls means
 * four chances to end up somewhere between the old list and the new one — with
 * no way to tell afterwards which of them landed.
 *
 * Local state until Save, then one PUT.
 */
function Picker({ handoverId, instanceId, assignees, onClose, onSaved }) {
  const [members, setMembers] = useState(null);
  const [picked,  setPicked]  = useState(() => new Set(assignees.map(a => a.userId)));
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState(null);

  const ownerId = assignees.find(a => a.isOwner)?.userId ?? null;
  const boxRef  = useRef(null);

  useEffect(() => {
    let live = true;
    // axios: the payload is under .data, and an error body under
    // .response.data — the convention TaskWorkComposer and ProjectPlanImport
    // already follow.
    apiService.handovers.listAssignableMembers(handoverId)
      .then(({ data }) => { if (live) setMembers(data || []); })
      .catch(e => { if (live) setErr(
        e?.response?.data?.error?.message || 'Could not load the project team'); });
    return () => { live = false; };
  }, [handoverId]);

  // Escape closes. A popover that can only be dismissed by clicking a specific
  // button traps someone who opened it by accident on a row they were trying
  // to expand — and this whole cell sits inside a row with its own onClick.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = useCallback((userId) => {
    if (userId === ownerId) return;          // refused server-side and in the db
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }, [ownerId]);

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      const { data } = await apiService.handovers.setPlayAssignees(
        handoverId, instanceId, [...picked]);
      onSaved(data?.assignees || []);
      onClose();
    } catch (e) {
      // NOT_PROJECT_MEMBER carries the ids it refused. Naming them beats a
      // sentence that says some of them were wrong without saying which.
      const ids = e?.response?.data?.error?.userIds;
      const named = ids && members
        ? ids.map(id => members.find(m => m.userId === id)?.name || `#${id}`).join(', ')
        : null;
      setErr(named
        ? `Not on this project: ${named}. Add them to the project team first.`
        : (e?.response?.data?.error?.message || 'Could not save'));
      setSaving(false);
    }
  }, [handoverId, instanceId, picked, members, onSaved, onClose]);

  return (
    <div
      ref={boxRef}
      onClick={e => e.stopPropagation()}   // the checklist row toggles on click
      style={{
        position: 'absolute', zIndex: 40, marginTop: 4, width: 260,
        background: '#fff', border: '1px solid #d1d5db', borderRadius: 8,
        boxShadow: '0 4px 12px rgba(0,0,0,0.08)', padding: 12,
      }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
        Project members only
      </div>

      {members === null && !err && (
        <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>Loading…</div>
      )}

      {members && members.length === 0 && (
        <div style={{ fontSize: 12, color: '#6b7280', padding: '8px 0' }}>
          Nobody is on this project yet. Add members before assigning tasks.
        </div>
      )}

      {members && members.map(m => {
        const isOwner = m.userId === ownerId;
        const on = picked.has(m.userId);
        return (
          <label key={m.userId}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '5px 0', borderBottom: '1px solid #f3f4f6',
              cursor: isOwner ? 'default' : 'pointer',
            }}>
            <input type="checkbox" checked={on || isOwner} disabled={isOwner}
              onChange={() => toggle(m.userId)} />
            <span style={{ fontSize: 13, flex: 1, color: '#111827' }}>{m.name || `#${m.userId}`}</span>
            {isOwner && <span style={{ fontSize: 11, color: '#1d4ed8' }}>owner</span>}
          </label>
        );
      })}

      {err && (
        <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 8 }}>{err}</div>
      )}

      <div style={{
        marginTop: 10, paddingTop: 10, borderTop: '1px solid #e5e7eb',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <button type="button" onClick={save} disabled={saving || members === null}
          style={{
            fontSize: 12, padding: '4px 10px', borderRadius: 6,
            border: '1px solid #2563eb', background: '#2563eb', color: '#fff',
            cursor: saving ? 'default' : 'pointer',
          }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onClose}
          style={{
            fontSize: 12, padding: '4px 10px', borderRadius: 6,
            border: '1px solid #d1d5db', background: '#fff', color: '#374151',
            cursor: 'pointer',
          }}>
          Cancel
        </button>
        <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto' }}>
          Closing the task closes it for everyone
        </span>
      </div>
    </div>
  );
}

/**
 * @param {object[]} assignees  from GET /play-assignees, keyed by instance id
 *                              in the caller. Passed in rather than fetched
 *                              here: the checklist draws many rows and one
 *                              request per row is the thing the bulk endpoint
 *                              exists to avoid.
 * @param {function} onChange   (instanceId, assignees) — so the caller can
 *                              update its map without refetching the project.
 * @param {boolean}  canEdit    the caller's existing canEditPlan && !done. The
 *                              server decides for real (manager or the task's
 *                              owner); this only hides a control that would be
 *                              refused.
 */
export default function PlayAssigneeCell({
  handoverId, instanceId, assignees = [], canEdit = false, onChange,
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative' }}>
      <Chips assignees={assignees} canEdit={canEdit}
        onOpen={() => setOpen(true)} />
      {open && (
        <Picker
          handoverId={handoverId}
          instanceId={instanceId}
          assignees={assignees}
          onClose={() => setOpen(false)}
          onSaved={rows => onChange && onChange(instanceId, rows)}
        />
      )}
    </div>
  );
}
