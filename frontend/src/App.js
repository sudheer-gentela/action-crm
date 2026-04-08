import React, { useState, useEffect } from 'react';
import './App.css';
import AccountsView from './AccountsView';
import DealsView from './DealsView';
import ContactsView from './ContactsView';
import EmailView from './EmailView';
import ActionsView from './ActionsView';
import CalendarView from './CalendarView';
import FilesView from './FilesView';
import SettingsView from './SettingsView';
import SuperAdminView from './SuperAdminView';
import OrgAdminView from './OrgAdminView';
import ActionContextPanel from './ActionContextPanel';
import AgentInboxView from './AgentInboxView';
import PlaybooksView from './PlaybooksView';
import PlaybookDetail from './PlaybookDetail';
import PlaybookRegister from './PlaybookRegister';
import PlaybookApprovals from './PlaybookApprovals';

// Normalise the modules object from /org/context into a simple { key: boolean } map.
// Handles both legacy scalar format (true/false) and new object format ({ allowed, enabled }).
function normaliseModules(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const result = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === null || val === undefined) {
      result[key] = false;
    } else if (typeof val === 'object') {
      result[key] = !!val.enabled;
    } else {
      result[key] = val === true || val === 'true';
    }
  }
  return result;
}
import ProspectingView from './ProspectingView';
import ContractsView from './ContractsView';
import HandoverView from './HandoverView';
import SupportView from './SupportView';
import AgencyView from './AgencyView';
import Sidebar from './Sidebar';

// ─────────────────────────────────────────────────────────────
// ROLE DEFINITIONS
// ─────────────────────────────────────────────────────────────

// Modules not in the sidebar nav — accessible only via the launcher
const ALL_MODULE_ITEMS = [
  { id: 'prospecting', label: 'Prospecting', icon: '🎯' },
  { id: 'contracts',   label: 'Contracts',   icon: '📄' },
  { id: 'handovers',   label: 'Handovers',   icon: '🤝' },
  { id: 'service',     label: 'Service',     icon: '🎧' },
  { id: 'agency',      label: 'Agency',      icon: '🏢' },
];

const NAV_ITEMS_BY_ROLE = {
  member: [
    { id: 'actions',      label: 'Actions',      icon: '⚡' },
    { id: 'deals',        label: 'Deals',        icon: '💼' },
    { id: 'accounts',     label: 'Accounts',     icon: '🏢' },
    { id: 'contacts',     label: 'Contacts',     icon: '👥' },
    { id: 'email',        label: 'Email',        icon: '✉️' },
    { id: 'calendar',     label: 'Calendar',     icon: '📅' },
    { id: 'files',        label: 'Files',        icon: '📁' },
    { id: 'agent',        label: 'Agents',       icon: '🤖' },
    { id: 'playbooks',    label: 'Playbooks',    icon: '📋' },
    { id: 'settings',     label: 'Settings',     icon: '⚙️' },
  ],
  'org-admin': [
    { id: 'org-admin', label: 'Org Admin', icon: '🔑' },
  ],
  'super-admin': [
    { id: 'super-admin', label: 'Platform Admin', icon: '⚡' },
  ],
};

const DEFAULT_TAB_BY_ROLE = {
  member:       'actions',
  'org-admin':  'org-admin',
  'super-admin':'super-admin',
};

// ─────────────────────────────────────────────────────────────
// useAuth
// ─────────────────────────────────────────────────────────────
const useAuth = () => {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token    = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (token && userData) {
      setUser(JSON.parse(userData));
    }
    setLoading(false);
  }, []);

  const login = async (email, password) => {
    try {
      const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        let errorData;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          errorData = await response.json();
        } else {
          const text = await response.text();
          errorData = { error: { message: text || 'Login failed' } };
        }
        if (response.status === 429) {
          throw new Error(errorData.error?.message || 'Too many login attempts. Please try again later.');
        }
        throw new Error(errorData.error?.message || 'Login failed');
      }

      const data = await response.json();
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setUser(data.user);
      console.log('✅ Logged in | super_admin:', data.user.is_super_admin, '| org_role:', data.user.org_role);
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  };

  const register = async (email, password, firstName, lastName) => {
    try {
      const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, firstName, lastName }),
      });

      if (!response.ok) {
        let errorData;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          errorData = await response.json();
        } else {
          const text = await response.text();
          errorData = { error: { message: text || 'Registration failed' } };
        }
        if (response.status === 429) {
          throw new Error(errorData.error?.message || 'Too many registration attempts. Please try again later.');
        }
        throw new Error(errorData.error?.message || 'Registration failed');
      }

      const data = await response.json();
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setUser(data.user);
      console.log('✅ Registered successfully');
    } catch (error) {
      console.error('Register error:', error);
      throw error;
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sessionStorage.removeItem('activeRole');
    setUser(null);
  };

  return { user, login, register, logout, loading };
};

// ─────────────────────────────────────────────────────────────
// AuthScreen  (login · register · forgot-password · reset-password)
// ─────────────────────────────────────────────────────────────
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

function AuthScreen({ onLogin, onRegister, initialMode }) {
  // mode: 'login' | 'register' | 'forgot' | 'reset' | 'reset_done'
  const [mode,     setMode]     = useState(initialMode || 'login');
  const [formData, setFormData] = useState({ email: '', password: '', confirmPassword: '', firstName: '', lastName: '' });
  const [error,    setError]    = useState('');
  const [info,     setInfo]     = useState('');
  const [loading,  setLoading]  = useState(false);

  // Read reset token from URL on mount
  const [resetToken, setResetToken] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (t) {
      setResetToken(t);
      setMode('reset');
    }
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const go = (newMode) => {
    setMode(newMode);
    setError('');
    setInfo('');
    setFormData({ email: '', password: '', confirmPassword: '', firstName: '', lastName: '' });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      if (mode === 'register') {
        if (!formData.firstName.trim()) throw new Error('First name is required');
        if (!formData.lastName.trim())  throw new Error('Last name is required');
        if (formData.password.length < 8) throw new Error('Password must be at least 8 characters');
        await onRegister(formData.email, formData.password, formData.firstName, formData.lastName);

      } else if (mode === 'login') {
        await onLogin(formData.email, formData.password);

      } else if (mode === 'forgot') {
        const res  = await fetch(`${API_URL}/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: formData.email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Request failed');
        setInfo(data.message);

      } else if (mode === 'reset') {
        if (formData.password.length < 8) throw new Error('Password must be at least 8 characters');
        if (formData.password !== formData.confirmPassword) throw new Error('Passwords do not match');
        const res  = await fetch(`${API_URL}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: resetToken, password: formData.password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Reset failed');
        // Clear token from URL and go to success state
        window.history.replaceState({}, '', window.location.pathname);
        setMode('reset_done');
      }
    } catch (err) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const logo = (
    <div className="login-logo">
      <svg width="56" height="56" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
        <rect width="72" height="72" rx="16" fill="#E8630A"/>
        <path d="M36 10 C28 20 16 28 18 44 C20 56 28 65 36 70 C44 65 52 56 54 44 C56 28 44 20 36 10Z" fill="#F5A623"/>
        <path d="M36 26 C32 32 28 38 30 46 C32 52 34 57 36 60 C38 57 40 52 42 46 C44 38 40 32 36 26Z" fill="#FDE68A"/>
        <path d="M24 46 L28 58 L33 49 L36 56 L39 49 L44 58 L48 46" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.95"/>
      </svg>
    </div>
  );

  // ── Reset done ────────────────────────────────────────────────────────────
  if (mode === 'reset_done') {
    return (
      <div className="login-container">
        <div className="login-box">
          {logo}
          <h1 className="login-brand">Go<span className="brand-warm">Warm</span> <span className="brand-crm">CRM</span></h1>
          <p className="login-subtitle">Password Updated</p>
          <div className="success-message" style={{ marginTop: 16 }}>
            ✅ Your password has been reset successfully.
          </div>
          <div className="auth-toggle" style={{ marginTop: 20 }}>
            <button type="button" className="btn-toggle" onClick={() => go('login')}>
              Sign In with your new password →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Forgot password ───────────────────────────────────────────────────────
  if (mode === 'forgot') {
    return (
      <div className="login-container">
        <div className="login-box">
          {logo}
          <h1 className="login-brand">Go<span className="brand-warm">Warm</span> <span className="brand-crm">CRM</span></h1>
          <p className="login-subtitle">Reset your password</p>

          {info ? (
            <>
              <div className="success-message" style={{ marginTop: 16, textAlign: 'left' }}>
                📧 {info}
              </div>
              <div className="auth-toggle" style={{ marginTop: 20 }}>
                <button type="button" className="btn-toggle" onClick={() => go('login')}>
                  ← Back to Sign In
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="login-form" style={{ marginTop: 24 }}>
              <div className="form-group">
                <label>Email address</label>
                <input
                  type="email" name="email" value={formData.email} onChange={handleChange}
                  placeholder="you@company.com" required disabled={loading}
                  autoFocus
                />
              </div>
              {error && <div className="error-message">{error}</div>}
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? <><span className="spinner"></span>Sending...</> : 'Send Reset Link'}
              </button>
              <div className="auth-toggle">
                <button type="button" className="btn-toggle" onClick={() => go('login')} disabled={loading}>
                  ← Back to Sign In
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ── Reset password (from email link) ─────────────────────────────────────
  if (mode === 'reset') {
    return (
      <div className="login-container">
        <div className="login-box">
          {logo}
          <h1 className="login-brand">Go<span className="brand-warm">Warm</span> <span className="brand-crm">CRM</span></h1>
          <p className="login-subtitle">Choose a new password</p>

          <form onSubmit={handleSubmit} className="login-form" style={{ marginTop: 24 }}>
            <div className="form-group">
              <label>New Password</label>
              <input
                type="password" name="password" value={formData.password} onChange={handleChange}
                placeholder="At least 8 characters" required disabled={loading} minLength={8}
                autoFocus
              />
              <small className="form-hint">Minimum 8 characters</small>
            </div>
            <div className="form-group">
              <label>Confirm New Password</label>
              <input
                type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange}
                placeholder="Repeat your new password" required disabled={loading}
              />
            </div>
            {error && <div className="error-message">{error}</div>}
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? <><span className="spinner"></span>Resetting...</> : 'Set New Password'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Login / Register ──────────────────────────────────────────────────────
  return (
    <div className="login-container">
      <div className="login-box">
        {logo}
        <h1 className="login-brand">Go<span className="brand-warm">Warm</span> <span className="brand-crm">CRM</span></h1>
        <p className="login-subtitle">
          {mode === 'register' ? 'Create Your Account' : 'The Execution Application for your GTM Team'}
        </p>

        <form onSubmit={handleSubmit} className="login-form">
          {mode === 'register' && (
            <div className="form-row">
              <div className="form-group">
                <label>First Name</label>
                <input type="text" name="firstName" value={formData.firstName} onChange={handleChange} placeholder="John" required disabled={loading} />
              </div>
              <div className="form-group">
                <label>Last Name</label>
                <input type="text" name="lastName" value={formData.lastName} onChange={handleChange} placeholder="Doe" required disabled={loading} />
              </div>
            </div>
          )}

          <div className="form-group">
            <label>Email</label>
            <input type="email" name="email" value={formData.email} onChange={handleChange} placeholder="you@company.com" required disabled={loading} />
          </div>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password" name="password" value={formData.password} onChange={handleChange}
              placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
              required disabled={loading} minLength={mode === 'register' ? 8 : undefined}
            />
            {mode === 'register' && <small className="form-hint">Minimum 8 characters</small>}
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? (
              <><span className="spinner"></span>{mode === 'register' ? 'Creating Account...' : 'Signing In...'}</>
            ) : (
              mode === 'register' ? 'Create Account' : 'Sign In'
            )}
          </button>
        </form>

        {mode === 'login' && (
          <div style={{ textAlign: 'right', marginTop: 8 }}>
            <button
              type="button"
              onClick={() => go('forgot')}
              style={{ background: 'none', border: 'none', color: '#E8630A', fontSize: 13,
                       fontWeight: 600, cursor: 'pointer', padding: 0 }}
            >
              Forgot password?
            </button>
          </div>
        )}

        <div className="auth-toggle">
          <button type="button" className="btn-toggle" onClick={() => go(mode === 'register' ? 'login' : 'register')} disabled={loading}>
            {mode === 'register' ? 'Already have an account? Sign In' : 'Need an account? Create One'}
          </button>
        </div>

        {mode === 'login' && (
          <div className="demo-info">
            <p><strong>New to GoWarm CRM?</strong></p>
            <p>Click "Create One" above to get started!</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────
function Dashboard({ user, onLogout }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeContextAction, setActiveContextAction] = useState(null);
  const [pendingDealId, setPendingDealId]               = useState(null);
  const [pendingEmailDealId, setPendingEmailDealId]     = useState(null);
  const [pendingContactId, setPendingContactId]         = useState(null);
  const [pendingMeetingId, setPendingMeetingId]         = useState(null);
  const [pendingAccountId, setPendingAccountId]         = useState(null);
  const [pendingPlaybookFilter, setPendingPlaybookFilter] = useState(null);
  const [pendingPlaybookId, setPendingPlaybookId]         = useState(null);
  const [pendingContractId, setPendingContractId]       = useState(null);
  const [pendingHandoverId, setPendingHandoverId]       = useState(null);
  const [pendingActionId, setPendingActionId]           = useState(null); // Phase 4: deep-link from calendar
  const [sidebarOpen, setSidebarOpen]           = useState(false);
  const [isMobile, setIsMobile]                 = useState(window.innerWidth < 768);
  const [orgModules, setOrgModules]             = useState({});  // { contracts: true/false, ... }

  // Fetch org module flags once on mount — accessible to ALL roles via /org/context
  useEffect(() => {
    const token = localStorage.getItem('token');
    const API   = process.env.REACT_APP_API_URL || '';
    fetch(`${API}/org/context`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.modules) setOrgModules(normaliseModules(data.modules));
      })
      .catch(() => {}); // non-fatal — modules stay hidden if fetch fails
  }, []);

  const isSuperAdmin = user?.is_super_admin === true;
  const orgRole      = user?.org_role || user?.role || 'member';
  const isOrgAdmin   = orgRole === 'owner' || orgRole === 'admin';

  const availableRoles = [
    'member',
    ...(isOrgAdmin   ? ['org-admin']   : []),
    ...(isSuperAdmin ? ['super-admin'] : []),
  ];

  const [activeRole, setActiveRole] = useState(() => {
    const saved = sessionStorage.getItem('activeRole');
    return (saved && availableRoles.includes(saved)) ? saved : 'member';
  });

  const [currentTab, setCurrentTab] = useState(DEFAULT_TAB_BY_ROLE[activeRole]);

  const handleRoleSwitch = (role) => {
    if (role === activeRole) return;
    sessionStorage.setItem('activeRole', role);
    setActiveRole(role);
    setCurrentTab(DEFAULT_TAB_BY_ROLE[role]);
    // Notify any mounted components that read activeRole from sessionStorage
    window.dispatchEvent(new CustomEvent('roleSwitch', { detail: { role } }));
    if (isMobile) setSidebarOpen(false);
  };

  const navItems = NAV_ITEMS_BY_ROLE[activeRole] || NAV_ITEMS_BY_ROLE.member;

  // Only surface module items whose flag is enabled in org settings
  const enabledModuleItems = ALL_MODULE_ITEMS.filter(m => !!orgModules[m.id]);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) setSidebarOpen(false);
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleSidebar = () => {
    if (isMobile) {
      setSidebarOpen(!sidebarOpen);
    } else {
      setSidebarCollapsed(!sidebarCollapsed);
    }
  };

  const handleNavClick = (tab) => {
    setCurrentTab(tab);
    if (isMobile) setSidebarOpen(false);
  };

  useEffect(() => {
    const handleNavigate = (e) => {
      const detail = e.detail;

      if (typeof detail === 'string') {
        handleNavClick(detail);
        return;
      }

      if (detail?.resume && detail?.dealId) {
        const { tab, dealId } = detail;
        if (tab === 'email') {
          setPendingEmailDealId(dealId);
        } else if (tab === 'deals' || tab === 'files') {
          setPendingDealId(dealId);
        }
      }

      if (detail?.contractId) setPendingContractId(detail.contractId);
      if (detail?.handoverId)  setPendingHandoverId(detail.handoverId);
      if (detail?.contactId)  setPendingContactId(detail.contactId);
      if (detail?.meetingId)  setPendingMeetingId(detail.meetingId);
      if (detail?.accountId)  setPendingAccountId(detail.accountId);
      if (detail?.playbookFilter) setPendingPlaybookFilter(detail.playbookFilter);
      if (detail?.playbookId)     setPendingPlaybookId(detail.playbookId);
      if (detail?.actionId)   setPendingActionId(detail.actionId);

      // Use setTimeout to ensure pending state (e.g. playbookId) is committed
      // before the tab switch triggers a render of the new component
      setTimeout(() => handleNavClick(detail?.tab || detail), 0);
    };
    window.addEventListener('navigate', handleNavigate);
    return () => window.removeEventListener('navigate', handleNavigate);
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for open-contract events dispatched from DealContractsPanel
  useEffect(() => {
    const handleOpenContract = (e) => {
      if (!orgModules.contracts) return; // module disabled — ignore silently
      setPendingContractId(e.detail?.contractId || null);
      handleNavClick('contracts');
    };
    window.addEventListener('open-contract', handleOpenContract);
    return () => window.removeEventListener('open-contract', handleOpenContract);
  }, [orgModules]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for open-handover events dispatched from DealsView or deal panels
  useEffect(() => {
    const handleOpenHandover = (e) => {
      if (!orgModules.handovers) return;
      setPendingHandoverId(e.detail?.handoverId || null);
      handleNavClick('handovers');
    };
    window.addEventListener('open-handover', handleOpenHandover);
    return () => window.removeEventListener('open-handover', handleOpenHandover);
  }, [orgModules]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for module toggle events dispatched from OAModules (OrgAdminView)
  // Updates orgModules state instantly — no refresh needed.
  useEffect(() => {
    const handleModuleToggle = (e) => {
      const { module, enabled } = e.detail || {};
      if (module) setOrgModules(prev => ({ ...prev, [module]: !!enabled }));
    };
    window.addEventListener('moduleToggle', handleModuleToggle);
    return () => window.removeEventListener('moduleToggle', handleModuleToggle);
  }, []);

  useEffect(() => {
    const handleStartAction = (e) => setActiveContextAction(e.detail);
    window.addEventListener('startAction', handleStartAction);
    return () => window.removeEventListener('startAction', handleStartAction);
  }, []);

  useEffect(() => {
    const handleActionContext = (e) => {
      const { action } = e.detail || {};
      const dealId = action?.dealId || action?.deal?.id || action?.deal_id || null;
      if (dealId) setPendingDealId(dealId);
    };
    window.addEventListener('actionContext', handleActionContext);
    return () => window.removeEventListener('actionContext', handleActionContext);
  }, []);

  const allNavItems = Object.values(NAV_ITEMS_BY_ROLE).flat();
  const currentNavItem = allNavItems.find(item => item.id === currentTab);

  return (
    <div className="dashboard">
      <Sidebar
        user={user}
        navItems={navItems}
        allModuleItems={enabledModuleItems}
        currentTab={currentTab}
        onNavClick={handleNavClick}
        activeRole={activeRole}
        availableRoles={availableRoles}
        onRoleSwitch={handleRoleSwitch}
        onLogout={onLogout}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        isMobile={isMobile}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {activeContextAction && (
        <ActionContextPanel
          action={activeContextAction}
          onClose={() => setActiveContextAction(null)}
          onNavigate={(tab) => { handleNavClick(tab); }}
        />
      )}

      <main className={`main-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        {isMobile && (
          <div className="mobile-header">
            <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>☰</button>
            <div className="mobile-title">
              <span className="mobile-icon">{currentNavItem?.icon}</span>
              <span className="mobile-text">{currentNavItem?.label}</span>
            </div>
          </div>
        )}

        <div className="content-area">
          {currentTab === 'actions'     && <ActionsView openActionId={pendingActionId} onActionOpened={() => setPendingActionId(null)} />}
          {currentTab === 'prospecting' && (
            orgModules.prospecting
              ? <ProspectingView />
              : <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12, color:'#94a3b8' }}>
                  <div style={{ fontSize:48 }}>🎯</div>
                  <div style={{ fontSize:16, fontWeight:600, color:'#475569' }}>Prospecting module is disabled</div>
                  <div style={{ fontSize:13 }}>An org admin can enable it under Org Admin → Modules.</div>
                </div>
          )}
          {currentTab === 'deals'       && (
            <DealsView
              openDealId={pendingDealId}
              onDealOpened={() => setPendingDealId(null)}
            />
          )}
          {currentTab === 'contracts'   && (
            orgModules.contracts
              ? <ContractsView
                  openContractId={pendingContractId}
                  onContractOpened={() => setPendingContractId(null)}
                />
              : <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12, color:'#94a3b8' }}>
                  <div style={{ fontSize:48 }}>📄</div>
                  <div style={{ fontSize:16, fontWeight:600, color:'#475569' }}>Contracts module is disabled</div>
                  <div style={{ fontSize:13 }}>An org admin can enable it under Org Admin → Modules.</div>
                </div>
          )}
          {currentTab === 'handovers'   && (
            orgModules.handovers
              ? <HandoverView
                  openHandoverId={pendingHandoverId}
                  onHandoverOpened={() => setPendingHandoverId(null)}
                />
              : <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12, color:'#94a3b8' }}>
                  <div style={{ fontSize:48 }}>🤝</div>
                  <div style={{ fontSize:16, fontWeight:600, color:'#475569' }}>Handovers module is disabled</div>
                  <div style={{ fontSize:13 }}>An org admin can enable it under Org Admin → Modules.</div>
                </div>
          )}
          {currentTab === 'service'     && (
            orgModules.service
              ? <SupportView />
              : <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12, color:'#94a3b8' }}>
                  <div style={{ fontSize:48 }}>🎧</div>
                  <div style={{ fontSize:16, fontWeight:600, color:'#475569' }}>Service module is disabled</div>
                  <div style={{ fontSize:13 }}>An org admin can enable it under Org Admin → Service.</div>
                </div>
          )}
          {currentTab === 'agency'     && (
            orgModules.agency
              ? <AgencyView />
              : <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12, color:'#94a3b8' }}>
                  <div style={{ fontSize:48 }}>🏢</div>
                  <div style={{ fontSize:16, fontWeight:600, color:'#475569' }}>Agency module is disabled</div>
                  <div style={{ fontSize:13 }}>An org admin can enable it under Org Admin → Modules.</div>
                </div>
          )}
          {currentTab === 'accounts'    && (
            <AccountsView
              openAccountId={pendingAccountId}
              onAccountOpened={() => setPendingAccountId(null)}
            />
          )}
          {currentTab === 'contacts'    && (
            <ContactsView
              openContactId={pendingContactId}
              onContactOpened={() => setPendingContactId(null)}
            />
          )}
          {currentTab === 'email'       && (
            <EmailView
              dealId={pendingEmailDealId}
              onDealFilterApplied={() => setPendingEmailDealId(null)}
            />
          )}
          {currentTab === 'files'       && <FilesView pendingDealId={pendingDealId} onDealOpened={(dealId) => {
            if (dealId) {
              window.dispatchEvent(new CustomEvent('navigate', {
                detail: { tab: 'deals', resume: true, dealId },
              }));
            } else {
              setPendingDealId(null);
            }
          }} />}
          {currentTab === 'calendar'    && (
            <CalendarView
              openMeetingId={pendingMeetingId}
              onMeetingOpened={() => setPendingMeetingId(null)}
            />
          )}
          {currentTab === 'settings'    && <SettingsView />}
          {currentTab === 'agent'       && <AgentInboxView />}
          {currentTab === 'playbooks'   && (
            <PlaybooksView
              initialTypeFilter={pendingPlaybookFilter}
              key={pendingPlaybookFilter || 'default'}
            />
          )}
          {currentTab === 'playbook-detail' && pendingPlaybookId && (
            <PlaybookDetail
              playbookId={pendingPlaybookId}
              onBack={() => handleNavClick('playbooks')}
            />
          )}
          {currentTab === 'playbook-detail' && !pendingPlaybookId && (
            <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          )}
          {currentTab === 'playbook-register' && (
            <PlaybookRegister
              onSuccess={() => handleNavClick('playbooks')}
              onCancel={() => handleNavClick('playbooks')}
            />
          )}
          {currentTab === 'playbook-approvals' && (
            <PlaybookApprovals
              onBack={() => handleNavClick('playbooks')}
            />
          )}
          {currentTab === 'org-admin'   && activeRole === 'org-admin'   && <OrgAdminView />}
          {currentTab === 'super-admin' && activeRole === 'super-admin' && <SuperAdminView />}
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────
function App() {
  const { user, login, register, logout, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      {!user ? (
        <AuthScreen
          onLogin={login}
          onRegister={register}
          initialMode={new URLSearchParams(window.location.search).get('token') ? 'reset' : 'login'}
        />
      ) : (
        <Dashboard user={user} onLogout={logout} />
      )}
    </div>
  );
}

export default App;
