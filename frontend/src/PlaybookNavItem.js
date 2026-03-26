// ============================================================
// ActionCRM Playbook Builder — D1: Sidebar Integration
// File: frontend/src/PlaybookNavItem.js
//
// HOW TO USE — in Sidebar.js:
//
//   import { PlaybookNavItem, PlaybookAdminNavItems } from './PlaybookNavItem';
//
//   Pass these props from wherever your Sidebar receives its data:
//     currentUser   — the logged-in user object (needs .role and .playbook_access)
//     badgeCount    — integer: pending count from app-level state (see below)
//     navigate      — from useNavigate() or passed down from App
//     activePath    — location.pathname
//
//   Badge count logic (compute in App.js or a context, not in the Sidebar):
//     org_admin   → count of registrations with status 'submitted'
//     owner       → count of their playbooks with a version 'under_review'
//     end_user    → 0 (no badge)
//
//   Example in App.js after fetching playbooks:
//     const [playbookBadgeCount, setPlaybookBadgeCount] = useState(0);
//     useEffect(() => {
//       if (!currentUser) return;
//       if (currentUser.role === 'org_admin') {
//         apiService.get('/api/playbook-registrations', { params: { status: 'submitted' } })
//           .then(r => setPlaybookBadgeCount(r.registrations?.length ?? 0))
//           .catch(() => {});
//       }
//     }, [currentUser]);
// ============================================================

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export function PlaybookNavItem({ currentUser, badgeCount = 0 }) {
  const navigate   = useNavigate();
  const { pathname } = useLocation();

  const isAdmin  = currentUser?.role === 'org_admin';
  const isActive = pathname.startsWith('/playbooks') || pathname.startsWith('/admin/playbooks');

  // Hide entirely for users who have no playbook access at all.
  // playbook_access is resolved at login and stored on the user profile.
  // null means no access; undefined means not yet resolved — show the item.
  if (currentUser?.playbook_access === null) return null;

  return (
    <div
      className={`sidebar-item ${isActive ? 'sidebar-item--active' : ''}`}
      onClick={() => navigate(isAdmin ? '/admin/playbooks' : '/playbooks')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(isAdmin ? '/admin/playbooks' : '/playbooks')}
    >
      <span className="sidebar-icon">📋</span>
      <span className="sidebar-label">Playbooks</span>
      {badgeCount > 0 && (
        <span className="sidebar-badge">{badgeCount}</span>
      )}
    </div>
  );
}

// Sub-nav items shown beneath the Playbooks item when the user is an org admin.
// Render these conditionally: only when the Playbooks item is active.
export function PlaybookAdminNavItems() {
  const navigate     = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="sidebar-subnav">
      <div
        className={`sidebar-subitem ${pathname === '/admin/playbooks' ? 'sidebar-subitem--active' : ''}`}
        onClick={() => navigate('/admin/playbooks')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && navigate('/admin/playbooks')}
      >
        Approvals
      </div>
      <div
        className={`sidebar-subitem ${pathname.startsWith('/playbooks') && !pathname.startsWith('/admin') ? 'sidebar-subitem--active' : ''}`}
        onClick={() => navigate('/playbooks')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && navigate('/playbooks')}
      >
        All Playbooks
      </div>
    </div>
  );
}
