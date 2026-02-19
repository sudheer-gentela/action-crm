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

// Authentication hook with REAL backend integration
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
      const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        let errorData;
        const contentType = response.headers.get('content-type');
        
        // Handle JSON error responses
        if (contentType && contentType.includes('application/json')) {
          errorData = await response.json();
        } else {
          // Handle plain text error responses (like rate limit text)
          const text = await response.text();
          errorData = { error: { message: text || 'Login failed' } };
        }
        
        // Handle rate limiting specifically
        if (response.status === 429) {
          throw new Error(errorData.error?.message || 'Too many login attempts. Please try again later.');
        }
        
        throw new Error(errorData.error?.message || 'Login failed');
      }

      const data = await response.json();
      
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setUser(data.user);
      
      console.log('✅ Logged in successfully with real token');
      
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
        headers: {
          'Content-Type': 'application/json',
        },
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
      
      console.log('✅ Registered successfully with real token');
      
    } catch (error) {
      console.error('Register error:', error);
      throw error;
    }
  };
  
  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };
  
  return { user, login, register, logout, loading };
};

// Login/Register Screen
function AuthScreen({ onLogin, onRegister }) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    
    try {
      if (isRegistering) {
        if (!formData.firstName.trim()) {
          throw new Error('First name is required');
        }
        if (!formData.lastName.trim()) {
          throw new Error('Last name is required');
        }
        if (formData.password.length < 8) {
          throw new Error('Password must be at least 8 characters');
        }
        
        await onRegister(
          formData.email,
          formData.password,
          formData.firstName,
          formData.lastName
        );
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
    setFormData({
      email: '',
      password: '',
      firstName: '',
      lastName: ''
    });
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
            <>
              <div className="form-row">
                <div className="form-group">
                  <label>First Name</label>
                  <input
                    type="text"
                    name="firstName"
                    value={formData.firstName}
                    onChange={handleChange}
                    placeholder="John"
                    required
                    disabled={loading}
                  />
                </div>
                
                <div className="form-group">
                  <label>Last Name</label>
                  <input
                    type="text"
                    name="lastName"
                    value={formData.lastName}
                    onChange={handleChange}
                    placeholder="Doe"
                    required
                    disabled={loading}
                  />
                </div>
              </div>
            </>
          )}
          
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="you@company.com"
              required
              disabled={loading}
            />
          </div>
          
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder={isRegistering ? 'At least 8 characters' : '••••••••'}
              required
              disabled={loading}
              minLength={isRegistering ? 8 : undefined}
            />
            {isRegistering && (
              <small className="form-hint">Minimum 8 characters</small>
            )}
          </div>
          
          {error && <div className="error-message">{error}</div>}
          
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner"></span>
                {isRegistering ? 'Creating Account...' : 'Signing In...'}
              </>
            ) : (
              isRegistering ? 'Create Account' : 'Sign In'
            )}
          </button>
        </form>
        
        <div className="auth-toggle">
          <button 
            type="button" 
            className="btn-toggle"
            onClick={toggleMode}
            disabled={loading}
          >
            {isRegistering 
              ? 'Already have an account? Sign In' 
              : 'Need an account? Create One'}
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

// Main Dashboard with Sidebar
function Dashboard({ user, onLogout }) {
  const [currentTab, setCurrentTab] = useState('actions');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) {
        setSidebarOpen(false);
      }
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
    if (isMobile) {
      setSidebarOpen(false);
    }
  };

  // Allow child views to navigate programmatically via custom event
  useEffect(() => {
    const handleNavigate = (e) => handleNavClick(e.detail);
    window.addEventListener('navigate', handleNavigate);
    return () => window.removeEventListener('navigate', handleNavigate);
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps
  
  const navItems = [
    { id: 'actions',  label: 'Actions',  icon: '🎯' },
    { id: 'deals',    label: 'Deals',    icon: '💼' },
    { id: 'accounts', label: 'Accounts', icon: '🏢' },
    { id: 'contacts', label: 'Contacts', icon: '👥' },
    { id: 'email',    label: 'Email',    icon: '✉️' },
    { id: 'files',    label: 'Files',    icon: '☁️' },
    { id: 'calendar', label: 'Calendar', icon: '📅' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];
  
  return (
    <div className="dashboard">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">
            <span className="logo-icon">⚡</span>
            {!sidebarCollapsed && <span className="logo-text">Action CRM</span>}
          </div>
          <button className="sidebar-toggle" onClick={toggleSidebar} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {isMobile ? '✕' : (sidebarCollapsed ? '→' : '←')}
          </button>
        </div>
        
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
        
        <div className="sidebar-footer">
          <div className="user-info">
            <span className="user-icon">👤</span>
            {!sidebarCollapsed && (
              <div className="user-details">
                <span className="user-email">{user.email}</span>
                <span className="user-name">{user.firstName} {user.lastName}</span>
              </div>
            )}
          </div>
          <button className="logout-btn" onClick={onLogout} title="Logout">
            <span className="logout-icon">🚪</span>
            {!sidebarCollapsed && <span className="logout-text">Logout</span>}
          </button>
        </div>
      </aside>
      
      {isMobile && sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)}></div>
      )}
      
      <main className={`main-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
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
        
        <div className="content-area">
          {currentTab === 'actions'  && <ActionsView />}
          {currentTab === 'deals'    && <DealsView />}
          {currentTab === 'accounts' && <AccountsView />}
          {currentTab === 'contacts' && <ContactsView />}
          {currentTab === 'email'    && <EmailView />}
          {currentTab === 'files'    && <FilesView />}
          {currentTab === 'calendar' && <CalendarView />}
          {currentTab === 'settings' && <SettingsView />}
        </div>
      </main>
    </div>
  );
}

// Main App Component
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
