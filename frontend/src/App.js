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
import ProspectingView from './ProspectingView';
import ContractsView from './ContractsView';
import Sidebar from './Sidebar';

// ─────────────────────────────────────────────────────────────
// ROLE DEFINITIONS
// ─────────────────────────────────────────────────────────────

const NAV_ITEMS_BY_ROLE = {
  member: [
    { id: 'actions',      label: 'Actions',      icon: '⚡' },
    { id: 'prospecting',  label: 'Prospecting',  icon: '🎯' },
    { id: 'deals',        label: 'Deals',        icon: '💼' },
    { id: 'contracts',    label: 'Contracts',    icon: '📄' },
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
// AuthScreen
// ─────────────────────────────────────────────────────────────
function AuthScreen({ onLogin, onRegister }) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [formData, setFormData] = useState({ email: '', password: '', firstName: '', lastName: '' });
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isRegistering) {
        if (!formData.firstName.trim()) throw new Error('First name is required');
        if (!formData.lastName.trim())  throw new Error('Last name is required');
        if (formData.password.length < 8) throw new Error('Password must be at least 8 characters');
        await onRegister(formData.email, formData.password, formData.firstName, formData.lastName);
      } else {
        await onLogin(formData.email, formData.password);
      }
    } catch (err) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setIsRegistering(!isRegistering);
    setError('');
    setFormData({ email: '', password: '', firstName: '', lastName: '' });
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-logo">⚡</div>
        <h1>Action CRM</h1>
        <p className="login-subtitle">
          {isRegistering ? 'Create Your Account' : 'AI-Powered Sales Pipeline'}
        </p>

        <form onSubmit={handleSubmit} className="login-form">
          {isRegistering && (
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
              placeholder={isRegistering ? 'At least 8 characters' : '••••••••'}
              required disabled={loading} minLength={isRegistering ? 8 : undefined}
            />
            {isRegistering && <small className="form-hint">Minimum 8 characters</small>}
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? (
              <><span className="spinner"></span>{isRegistering ? 'Creating Account...' : 'Signing In...'}</>
            ) : (
              isRegistering ? 'Create Account' : 'Sign In'
            )}
          </button>
        </form>

        <div className="auth-toggle">
          <button type="button" className="btn-toggle" onClick={toggleMode} disabled={loading}>
            {isRegistering ? 'Already have an account? Sign In' : 'Need an account? Create One'}
          </button>
        </div>

        {!isRegistering && (
          <div className="demo-info">
            <p><strong>New to Action CRM?</strong></p>
            <p>Click "Create One" above to get started!</p>
          </div>
        )}

        <div className="deployment-info">
          <p><strong>Backend API:</strong></p>
          <code>{process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}</code>
        </div>
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
  const [pendingContractId, setPendingContractId]       = useState(null);
  const [sidebarOpen, setSidebarOpen]           = useState(false);
  const [isMobile, setIsMobile]                 = useState(window.innerWidth < 768);

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
    if (isMobile) setSidebarOpen(false);
  };

  const navItems = NAV_ITEMS_BY_ROLE[activeRole] || NAV_ITEMS_BY_ROLE.member;

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

      if (detail?.contactId) setPendingContactId(detail.contactId);
      if (detail?.meetingId)  setPendingMeetingId(detail.meetingId);
      if (detail?.accountId)  setPendingAccountId(detail.accountId);
      if (detail?.playbookFilter) setPendingPlaybookFilter(detail.playbookFilter);

      handleNavClick(detail?.tab || detail);
    };
    window.addEventListener('navigate', handleNavigate);
    return () => window.removeEventListener('navigate', handleNavigate);
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for open-contract events dispatched from DealContractsPanel
  useEffect(() => {
    const handleOpenContract = (e) => {
      setPendingContractId(e.detail?.contractId || null);
      handleNavClick('contracts');
    };
    window.addEventListener('open-contract', handleOpenContract);
    return () => window.removeEventListener('open-contract', handleOpenContract);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
          {currentTab === 'actions'     && <ActionsView />}
          {currentTab === 'prospecting' && <ProspectingView />}
          {currentTab === 'deals'       && (
            <DealsView
              openDealId={pendingDealId}
              onDealOpened={() => setPendingDealId(null)}
            />
          )}
          {currentTab === 'contracts'   && (
            <ContractsView
              openContractId={pendingContractId}
              onContractOpened={() => setPendingContractId(null)}
            />
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
              // Set the deal ID first, then switch tab on next tick so DealsView
              // mounts with openDealId already set
              setPendingDealId(dealId);
              setTimeout(() => setCurrentTab('deals'), 0);
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
        <AuthScreen onLogin={login} onRegister={register} />
      ) : (
        <Dashboard user={user} onLogout={logout} />
      )}
    </div>
  );
}

export default App;
