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

// Main Dashboard
function Dashboard({ user, onLogout }) {
  const [currentTab, setCurrentTab] = useState('actions');
  
  return (
    <div className="dashboard">
      {/* Navigation Bar */}
      <nav className="navbar">
        <div className="navbar-left">
          <div className="logo">
            <span>⚡</span>
            Action CRM
          </div>
          <div className="nav-links">
            <button 
              className={currentTab === 'actions' ? 'active' : ''} 
              onClick={() => setCurrentTab('actions')}
            >
              Actions
            </button>
            <button 
              className={currentTab === 'deals' ? 'active' : ''} 
              onClick={() => setCurrentTab('deals')}
            >
              Deals
            </button>
            <button 
              className={currentTab === 'accounts' ? 'active' : ''} 
              onClick={() => setCurrentTab('accounts')}
            >
              Accounts
            </button>
            <button 
              className={currentTab === 'contacts' ? 'active' : ''} 
              onClick={() => setCurrentTab('contacts')}
            >
              Contacts
            </button>
            <button 
              className={currentTab === 'email' ? 'active' : ''} 
              onClick={() => setCurrentTab('email')}
            >
              Email
            </button>
            <button 
              className={currentTab === 'calendar' ? 'active' : ''} 
              onClick={() => setCurrentTab('calendar')}
            >
              Calendar
            </button>
          </div>
        </div>
        <div className="navbar-right">
          <div className="user-menu">
            <span>{user.email}</span>
            <button onClick={onLogout} className="btn-logout">Logout</button>
          </div>
        </div>
      </nav>
      
      {/* Main Content */}
      <div className="main-content">
        {currentTab === 'actions' && <ActionsView />}
        {currentTab === 'deals' && <DealsView />}
        {currentTab === 'accounts' && <AccountsView />}
        {currentTab === 'contacts' && <ContactsView />}
        {currentTab === 'email' && <EmailView />}
        {currentTab === 'calendar' && <CalendarView />}
      </div>
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
