import React, { useState, useEffect, useRef } from 'react';
import './Sidebar.css';

// ─────────────────────────────────────────────────────────────
// ROLE DISPLAY CONFIG
// ─────────────────────────────────────────────────────────────
const ROLE_BADGE_CONFIG = {
  member:        { label: 'Member',     className: 'member' },
  'org-admin':   { label: 'Org Admin',  className: 'org-admin' },
  'super-admin': { label: 'Super User', className: 'super-user' },
};

// ─────────────────────────────────────────────────────────────
// NAV STRUCTURE
// contracts added to Pipeline section, after deals
// ─────────────────────────────────────────────────────────────
const MEMBER_NAV_SECTIONS = [
  {
    id: 'pipeline',
    label: 'Pipeline',
    items: ['actions', 'prospecting', 'deals', 'contacts', 'accounts'],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    items: ['email', 'calendar', 'files'],
  },
  {
    id: 'resources',
    label: 'Resources',
    items: ['agent', 'playbooks'],
  },
];

const BOTTOM_ITEMS = ['settings'];

// ─────────────────────────────────────────────────────────────
// NavSection
// ─────────────────────────────────────────────────────────────
function NavSection({ section, navItemMap, currentTab, onNavClick, collapsed: sidebarCollapsed }) {
  const [open, setOpen] = useState(true);

  if (sidebarCollapsed) {
    return (
      <div className="sb-nav-section">
        {section.items.map(id => {
          const item = navItemMap[id];
          if (!item) return null;
          return (
            <button
              key={id}
              className={`sb-nav-item ${currentTab === id ? 'active' : ''}`}
              onClick={() => onNavClick(id)}
              title={item.label}
            >
              <span className="sb-nav-icon">{item.icon}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`sb-nav-section ${!open ? 'collapsed' : ''}`}>
      <div className="sb-section-header" onClick={() => setOpen(o => !o)}>
        <span className="sb-section-title">{section.label}</span>
        <span className="sb-section-chevron">{open ? '▾' : '›'}</span>
      </div>
      {open && (
        <div className="sb-section-items">
          {section.items.map(id => {
            const item = navItemMap[id];
            if (!item) return null;
            return (
              <button
                key={id}
                className={`sb-nav-item ${currentTab === id ? 'active' : ''}`}
                onClick={() => onNavClick(id)}
              >
                <span className="sb-nav-icon">{item.icon}</span>
                <span className="sb-nav-label">{item.label}</span>
                {item.badge && <span className="sb-nav-badge">{item.badge}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// UserCard
// ─────────────────────────────────────────────────────────────
function UserCard({ user, activeRole, availableRoles, onRoleSwitch, onLogout, collapsed }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const cardRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (cardRef.current && !cardRef.current.contains(e.target)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const initials = `${(user.firstName || '')[0] || ''}${(user.lastName || '')[0] || ''}`.toUpperCase() || '?';
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
  const roleCfg = ROLE_BADGE_CONFIG[activeRole] || ROLE_BADGE_CONFIG.member;

  if (collapsed) {
    return (
      <div className="sb-user-card sb-user-card--collapsed" title={`${fullName} (${roleCfg.label})`}>
        <div className="sb-user-avatar">
          <span className="sb-user-initials">{initials}</span>
          <span className="sb-online-dot" />
        </div>
      </div>
    );
  }

  return (
    <div className="sb-user-card" ref={cardRef}>
      <div className="sb-user-card-trigger" onClick={() => setPopoverOpen(o => !o)}>
        <div className="sb-user-avatar">
          <span className="sb-user-initials">{initials}</span>
          <span className="sb-online-dot" />
        </div>
        <div className="sb-user-info">
          <div className="sb-user-name">{fullName}</div>
          <div className={`sb-user-role ${roleCfg.className}`}>{roleCfg.label}</div>
        </div>
        <span className="sb-user-chevron">⋮</span>
      </div>

      {popoverOpen && (
        <div className="sb-user-popover">
          <div className="sb-popover-header">
            <div className="sb-popover-org">{user.org_name || 'My Organization'}</div>
            <div className="sb-popover-email">{user.email}</div>
          </div>

          <button className="sb-popover-item" onClick={() => setPopoverOpen(false)}>
            <span>👤</span> My Profile
          </button>
          <button className="sb-popover-item" onClick={() => setPopoverOpen(false)}>
            <span>🔔</span> Notifications
          </button>

          {availableRoles.length > 1 && (
            <>
              <div className="sb-popover-divider" />
              <div className="sb-popover-section-label">Switch Role</div>
              {availableRoles.map(role => {
                const cfg = ROLE_BADGE_CONFIG[role] || ROLE_BADGE_CONFIG.member;
                const isActive = role === activeRole;
                return (
                  <button
                    key={role}
                    className={`sb-popover-item sb-popover-role ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      onRoleSwitch(role);
                      setPopoverOpen(false);
                    }}
                  >
                    <span className={`sb-role-indicator ${cfg.className}`} />
                    {cfg.label}
                    {isActive && <span className="sb-role-check">✓</span>}
                  </button>
                );
              })}
            </>
          )}

          <div className="sb-popover-divider" />
          <button className="sb-popover-item sb-popover-danger" onClick={onLogout}>
            <span>🚪</span> Sign Out
          </button>
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// ModuleLauncher — dots button + popover panel
// Sits above UserCard in sb-bottom. Uses existing sb-nav-item
// styles to match the sidebar perfectly.
// ─────────────────────────────────────────────────────────────
function ModuleLauncher({ allModuleItems = [], currentTab, onNavClick, collapsed }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const handleSelect = (id) => {
    onNavClick(id);
    setOpen(false);
  };

  return (
    <div className="sb-module-launcher" ref={ref}>
      <button
        className={`sb-nav-item sb-launcher-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="All modules"
      >
        <span className="sb-nav-icon">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="3" cy="3" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="3" r="1.8" fill="currentColor"/>
            <circle cx="3" cy="12" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
          </svg>
        </span>
        {!collapsed && <span className="sb-nav-label">All Modules</span>}
      </button>

      {open && (
        <div className={`sb-launcher-panel ${collapsed ? 'sb-launcher-panel--left' : 'sb-launcher-panel--above'}`}>
          <div className="sb-launcher-header">Modules</div>
          <div className="sb-launcher-grid">
            {allModuleItems.map(item => (
              <button
                key={item.id}
                className={`sb-launcher-tile ${currentTab === item.id ? 'sb-launcher-tile--active' : ''}`}
                onClick={() => handleSelect(item.id)}
                title={item.label}
              >
                <span className="sb-launcher-icon">{item.icon}</span>
                <span className="sb-launcher-label">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Sidebar — main export
// ─────────────────────────────────────────────────────────────
export default function Sidebar({
  user,
  navItems,
  allModuleItems,
  currentTab,
  onNavClick,
  activeRole,
  availableRoles,
  onRoleSwitch,
  onLogout,
  collapsed,
  onToggleCollapse,
  isMobile,
  open: mobileOpen,
  onClose,
}) {
  const navItemMap = {};
  navItems.forEach(item => { navItemMap[item.id] = item; });

  const isMemberRole = activeRole === 'member';

  return (
    <>
      <aside className={`sb-sidebar ${collapsed ? 'sb-collapsed' : ''} ${mobileOpen ? 'sb-open' : ''}`}>
        {/* Brand */}
        <div className="sb-brand">
          <div className="sb-brand-mark">A</div>
          {!collapsed && <span className="sb-brand-name">Action CRM</span>}
          <button
            className="sb-toggle-btn"
            onClick={isMobile ? onClose : onToggleCollapse}
            title={isMobile ? 'Close' : (collapsed ? 'Expand sidebar' : 'Collapse sidebar')}
          >
            {isMobile ? '✕' : (collapsed ? '→' : '←')}
          </button>
        </div>

        {/* Navigation */}
        <nav className="sb-nav">
          {isMemberRole ? (
            MEMBER_NAV_SECTIONS.map(section => (
              <NavSection
                key={section.id}
                section={section}
                navItemMap={navItemMap}
                currentTab={currentTab}
                onNavClick={onNavClick}
                collapsed={collapsed}
              />
            ))
          ) : (
            <div className="sb-nav-section">
              <div className="sb-section-items">
                {navItems.map(item => (
                  <button
                    key={item.id}
                    className={`sb-nav-item ${currentTab === item.id ? 'active' : ''}`}
                    onClick={() => onNavClick(item.id)}
                    title={collapsed ? item.label : ''}
                  >
                    <span className="sb-nav-icon">{item.icon}</span>
                    {!collapsed && <span className="sb-nav-label">{item.label}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </nav>

        {/* Bottom items + user card */}
        <div className="sb-bottom">
          {isMemberRole && BOTTOM_ITEMS.map(id => {
            const item = navItemMap[id];
            if (!item) return null;
            return (
              <button
                key={id}
                className={`sb-nav-item ${currentTab === id ? 'active' : ''}`}
                onClick={() => onNavClick(id)}
                title={collapsed ? item.label : ''}
              >
                <span className="sb-nav-icon">{item.icon}</span>
                {!collapsed && <span className="sb-nav-label">{item.label}</span>}
              </button>
            );
          })}

          {isMemberRole && (
            <ModuleLauncher
              allModuleItems={allModuleItems || []}
              currentTab={currentTab}
              onNavClick={onNavClick}
              collapsed={collapsed}
            />
          )}

          <UserCard
            user={user}
            activeRole={activeRole}
            availableRoles={availableRoles}
            onRoleSwitch={onRoleSwitch}
            onLogout={onLogout}
            collapsed={collapsed}
          />
        </div>
      </aside>

      {isMobile && mobileOpen && (
        <div className="sb-overlay" onClick={onClose} />
      )}
    </>
  );
}
