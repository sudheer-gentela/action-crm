// ============================================================
// ActionCRM Playbook Builder — D1: PlaybookNavItem
// File: frontend/src/PlaybookNavItem.js
//
// NOT used directly — Playbooks is already wired into Sidebar.js
// via the navItemMap ('playbooks' entry in NAV_ITEMS_BY_ROLE).
// This file is kept for any future standalone badge/sub-nav use.
// ============================================================

import React from 'react';

export function PlaybookNavItem({ currentUser, badgeCount = 0, currentTab, onNavClick }) {
  const isAdmin  = currentUser?.role === 'org_admin' || currentUser?.org_role === 'owner' || currentUser?.org_role === 'admin';
  const isActive = currentTab === 'playbooks' || currentTab === 'playbook-detail' ||
                   currentTab === 'playbook-register' || currentTab === 'playbook-approvals';

  if (currentUser?.playbook_access === null) return null;

  const dest = isAdmin ? 'playbook-approvals' : 'playbooks';

  return (
    <div
      className={`sidebar-item ${isActive ? 'sidebar-item--active' : ''}`}
      onClick={() => onNavClick ? onNavClick(dest) : window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: dest } }))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && (onNavClick ? onNavClick(dest) : window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: dest } })))}
    >
      <span className="sidebar-icon">📋</span>
      <span className="sidebar-label">Playbooks</span>
      {badgeCount > 0 && (
        <span className="sidebar-badge">{badgeCount}</span>
      )}
    </div>
  );
}

export function PlaybookAdminNavItems({ currentTab, onNavClick }) {
  const nav = (tab) => onNavClick ? onNavClick(tab) : window.dispatchEvent(new CustomEvent('navigate', { detail: { tab } }));
  return (
    <div className="sidebar-subnav">
      <div
        className={`sidebar-subitem ${currentTab === 'playbook-approvals' ? 'sidebar-subitem--active' : ''}`}
        onClick={() => nav('playbook-approvals')}
        role="button" tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && nav('playbook-approvals')}
      >
        Approvals
      </div>
      <div
        className={`sidebar-subitem ${currentTab === 'playbooks' ? 'sidebar-subitem--active' : ''}`}
        onClick={() => nav('playbooks')}
        role="button" tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && nav('playbooks')}
      >
        All Playbooks
      </div>
    </div>
  );
}

