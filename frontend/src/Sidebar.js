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
// NOTE: module IDs (prospecting, contracts, handovers, service, agency) are
// intentionally NOT listed in any section here — they're rendered separately
// via a dynamic "Pinned" section placed between Pipeline and Workflow when
// the user pins any of them. Actions stays first in Pipeline as the anchor.
// ─────────────────────────────────────────────────────────────
const MEMBER_NAV_SECTIONS = [
  {
    id: 'pipeline',
    label: 'Pipeline',
    items: ['actions', 'deals', 'contacts', 'accounts'],
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
function ModuleLauncher({
  allModuleItems = [],
  currentTab,
  onNavClick,
  collapsed,
  pinnedModuleIds = [],
  pinnedModulesCap = 2,
  onTogglePin,
}) {
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

  // Handle pin/unpin click — stops propagation so the tile itself doesn't
  // navigate. Returns early when at cap and trying to pin a new one.
  const handlePinClick = (e, id) => {
    e.stopPropagation();
    const isPinned = pinnedModuleIds.includes(id);
    if (!isPinned && pinnedModuleIds.length >= pinnedModulesCap) {
      // At cap — no-op. The pin button is already styled as disabled in this state.
      return;
    }
    if (onTogglePin) onTogglePin(id);
  };

  return (
    <div className="sb-module-launcher" ref={ref}>
      <button
        className={`sb-nav-item sb-launcher-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="More modules"
      >
        <span className="sb-nav-icon">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="3" cy="3" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="3" r="1.8" fill="currentColor"/>
            <circle cx="3" cy="12" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
          </svg>
        </span>
        {!collapsed && <span className="sb-nav-label">More</span>}
      </button>

      {open && (
        <div className={`sb-launcher-panel ${collapsed ? 'sb-launcher-panel--left' : 'sb-launcher-panel--above'}`}>
          <div className="sb-launcher-header">More Modules</div>
          <div className="sb-launcher-grid">
            {allModuleItems.map(item => {
              const isPinned = pinnedModuleIds.includes(item.id);
              const atCap    = !isPinned && pinnedModuleIds.length >= pinnedModulesCap;
              return (
                <button
                  key={item.id}
                  className={`sb-launcher-tile ${currentTab === item.id ? 'sb-launcher-tile--active' : ''} ${isPinned ? 'sb-launcher-tile--pinned' : ''}`}
                  onClick={() => handleSelect(item.id)}
                  title={item.label}
                  style={{ position: 'relative' }}
                >
                  <span
                    className="sb-launcher-pin"
                    onClick={e => handlePinClick(e, item.id)}
                    role="button"
                    tabIndex={0}
                    title={
                      isPinned ? 'Unpin from sidebar'
                      : atCap  ? `Unpin one first (max ${pinnedModulesCap} pinned)`
                      :          'Pin to sidebar'
                    }
                    style={{
                      position: 'absolute',
                      top: 4, right: 4,
                      fontSize: 12, lineHeight: 1,
                      padding: '2px 4px', borderRadius: 4,
                      cursor: atCap ? 'not-allowed' : 'pointer',
                      opacity: isPinned ? 1 : (atCap ? 0.25 : 0.55),
                      background: isPinned ? 'rgba(15, 157, 142, 0.15)' : 'transparent',
                      color:      isPinned ? '#0F9D8E' : 'inherit',
                      transition: 'opacity 0.15s, background 0.15s',
                    }}
                  >
                    {isPinned ? '📌' : '📍'}
                  </span>
                  <span className="sb-launcher-icon">{item.icon}</span>
                  <span className="sb-launcher-label">{item.label}</span>
                </button>
              );
            })}
          </div>
          <div style={{
            padding: '6px 10px',
            fontSize: 11,
            color: '#94a3b8',
            borderTop: '1px solid rgba(0,0,0,0.06)',
            marginTop: 4,
            lineHeight: 1.5,
          }}>
            📌 pinned to sidebar · 📍 click to pin ({pinnedModuleIds.length}/{pinnedModulesCap})
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
  pinnedModuleItems = [],
  pinnedModuleIds   = [],
  pinnedModulesCap  = 2,
  onTogglePin,
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
  // Merge pinned modules into the item map so NavSection can resolve them.
  pinnedModuleItems.forEach(item => { navItemMap[item.id] = item; });

  // Build the sections list. When the user has any modules pinned, insert a
  // dedicated "Pinned" section between Pipeline and Workflow — so Actions
  // stays first (daily landing spot) and pinned modules are visually grouped.
  const memberNavSections = pinnedModuleItems.length === 0
    ? MEMBER_NAV_SECTIONS
    : (() => {
        const pinnedSection = {
          id:    'pinned',
          label: 'Pinned',
          items: pinnedModuleItems.map(m => m.id),
        };
        // Insert right after Pipeline (index 0) — before Workflow.
        const pipelineIdx = MEMBER_NAV_SECTIONS.findIndex(s => s.id === 'pipeline');
        const insertAt    = pipelineIdx === -1 ? 0 : pipelineIdx + 1;
        return [
          ...MEMBER_NAV_SECTIONS.slice(0, insertAt),
          pinnedSection,
          ...MEMBER_NAV_SECTIONS.slice(insertAt),
        ];
      })();

  const isMemberRole = activeRole === 'member';

  return (
    <>
      <aside className={`sb-sidebar ${collapsed ? 'sb-collapsed' : ''} ${mobileOpen ? 'sb-open' : ''}`}>
        {/* Brand */}
        <div className="sb-brand">
          <div className="sb-brand-mark">
            <svg width="18" height="18" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
              <path d="M36 6 C26 18 12 26 14 44 C16 58 26 68 36 72 C46 68 56 58 58 44 C60 26 46 18 36 6Z" fill="#F5A623"/>
              <path d="M36 22 C31 30 26 36 28 46 C30 53 33 58 36 62 C39 58 42 53 44 46 C46 36 41 30 36 22Z" fill="#FDE68A"/>
              <path d="M22 46 L27 60 L33 50 L36 58 L39 50 L45 60 L50 46" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.95"/>
            </svg>
          </div>
          {!collapsed && <span className="sb-brand-name">Go<span className="sb-brand-warm">Warm</span> <span className="sb-brand-crm">CRM</span></span>}
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
            memberNavSections.map(section => (
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
              pinnedModuleIds={pinnedModuleIds}
              pinnedModulesCap={pinnedModulesCap}
              onTogglePin={onTogglePin}
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
