import React, { useState, useEffect } from 'react';
import './App.css';
import AccountsView from './AccountsView';
import DealsView from './DealsView';
import ContactsView from './ContactsView';
import EmailView from './EmailView';
import ActionsView from './ActionsView';
import CalendarView from './CalendarView';

// Simple authentication check
const useAuth = () => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const token = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (token && userData) {
      setUser(JSON.parse(userData));
    }
    setLoading(false);
  }, []);
  
  const login = async (email, password) => {
    try {
      const mockUser = { id: 1, email, name: email.split('@')[0] };
      localStorage.setItem('token', 'demo-token');
      localStorage.setItem('user', JSON.stringify(mockUser));
      setUser(mockUser);
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  };
  
  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };
  
  return { user, login, logout, loading };
};

// Login Screen
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    
    try {
      if (email && password) {
        await onLogin(email, password);
      }
    } catch (err) {
      setError('Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-logo">⚡</div>
        <h1>Action CRM</h1>
        <p className="login-subtitle">AI-Powered Sales Pipeline</p>
        
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              disabled={loading}
            />
          </div>
          
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={loading}
            />
          </div>
          
          {error && <div className="error-message">{error}</div>}
          
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        
        <div className="demo-info">
          <p>🎉 <strong>Demo Mode</strong> - Use any email/password to explore</p>
        </div>
        
        <div className="deployment-info">
          <p><strong>Backend API:</strong></p>
          <code>{process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}</code>
        </div>
      </div>
    </div>
  );
}

// Main Dashboard with Sidebar
function Dashboard({ user, onLogout }) {
  const [currentTab, setCurrentTab] = useState('actions');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  
  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) {
        setSidebarOpen(false);
      }
    };
    
    window.addEventListener('resize', handleResize);
    handleResize(); // Initial check
    
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
    if (isMobile) {
      setSidebarOpen(false);
    }
  };
  
  const navItems = [
    { id: 'actions', label: 'Actions', icon: '🎯' },
    { id: 'deals', label: 'Deals', icon: '💼' },
    { id: 'accounts', label: 'Accounts', icon: '🏢' },
    { id: 'contacts', label: 'Contacts', icon: '👥' },
    { id: 'email', label: 'Email', icon: '✉️' },
    { id: 'calendar', label: 'Calendar', icon: '📅' }
  ];
  
  return (
    <div className="dashboard">
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${sidebarOpen ? 'open' : ''}`}>
        {/* Sidebar Header */}
        <div className="sidebar-header">
          <div className="logo">
            <span className="logo-icon">⚡</span>
            {!sidebarCollapsed && <span className="logo-text">Action CRM</span>}
          </div>
          <button className="sidebar-toggle" onClick={toggleSidebar} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {isMobile ? '✕' : (sidebarCollapsed ? '→' : '←')}
          </button>
        </div>
        
        {/* Sidebar Navigation */}
        <nav className="sidebar-nav">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`nav-item ${currentTab === item.id ? 'active' : ''}`}
              onClick={() => handleNavClick(item.id)}
              title={sidebarCollapsed ? item.label : ''}
            >
              <span className="nav-icon">{item.icon}</span>
              {!sidebarCollapsed && <span className="nav-text">{item.label}</span>}
            </button>
          ))}
        </nav>
        
        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          <div className="user-info">
            <span className="user-icon">👤</span>
            {!sidebarCollapsed && (
              <div className="user-details">
                <span className="user-email">{user.email}</span>
                <span className="user-name">{user.name || 'User'}</span>
              </div>
            )}
          </div>
          <button className="logout-btn" onClick={onLogout} title="Logout">
            <span className="logout-icon">🚪</span>
            {!sidebarCollapsed && <span className="logout-text">Logout</span>}
          </button>
        </div>
      </aside>
      
      {/* Mobile Overlay */}
      {isMobile && sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)}></div>
      )}
      
      {/* Main Container */}
      <main className={`main-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        {/* Mobile Header */}
        {isMobile && (
          <div className="mobile-header">
            <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>
              ☰
            </button>
            <div className="mobile-title">
              <span className="mobile-icon">{navItems.find(item => item.id === currentTab)?.icon}</span>
              <span className="mobile-text">{navItems.find(item => item.id === currentTab)?.label}</span>
            </div>
          </div>
        )}
        
        {/* Main Content */}
        <div className="content-area">
          {currentTab === 'actions' && <ActionsView />}
          {currentTab === 'deals' && <DealsView />}
          {currentTab === 'accounts' && <AccountsView />}
          {currentTab === 'contacts' && <ContactsView />}
          {currentTab === 'email' && <EmailView />}
          {currentTab === 'calendar' && <CalendarView />}
        </div>
      </main>
    </div>
  );
}

// Main App Component
function App() {
  const { user, login, logout, loading } = useAuth();
  
  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner">Loading...</div>
      </div>
    );
  }
  
  return (
    <div className="App">
      {!user ? (
        <LoginScreen onLogin={login} />
      ) : (
        <Dashboard user={user} onLogout={logout} />
      )}
    </div>
  );
}

export default App;
