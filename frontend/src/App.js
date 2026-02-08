import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';
import DealForm from './DealForm';
import { apiService } from './apiService';
import AccountsView from './AccountsView';


// API Configuration
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

// Create axios instance with interceptor for auth
const api = axios.create({
  baseURL: API_URL,
});

// Add token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

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
      // For now, use demo mode
      // In production, replace with: const response = await api.post('/auth/login', { email, password });
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
          <code>{API_URL}</code>
        </div>
      </div>
    </div>
  );
}

// Main Dashboard
function Dashboard({ user, onLogout }) {
  const [currentTab, setCurrentTab] = useState('deals');
  
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

// Enhanced Deals View with CRUD
function DealsView() {
  const [deals, setDeals] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingDeal, setEditingDeal] = useState(null);
  const [error, setError] = useState('');

  // Fetch deals and accounts
  useEffect(() => {
    fetchDeals();
    fetchAccounts();
  }, []);

  const fetchDeals = async () => {
    try {
      setLoading(true);
      const response = await api.get('/deals');
      setDeals(response.data.deals || []);
      setError('');
    } catch (err) {
      console.error('Error fetching deals:', err);
      setError('Failed to load deals');
      // Use mock data if API fails
      setDeals(getMockDeals());
    } finally {
      setLoading(false);
    }
  };

  const fetchAccounts = async () => {
    try {
      const response = await api.get('/accounts');
      setAccounts(response.data.accounts || []);
    } catch (err) {
      console.error('Error fetching accounts:', err);
      // Use mock accounts if API fails
      setAccounts(getMockAccounts());
    }
  };

  const handleCreateDeal = async (dealData) => {
    try {
      const response = await api.post('/deals', dealData);
      setDeals([...deals, response.data.deal]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error creating deal:', err);
      // For demo, add to local state
      const newDeal = { ...dealData, id: Date.now() };
      setDeals([...deals, newDeal]);
      setShowForm(false);
    }
  };

  const handleUpdateDeal = async (dealData) => {
    try {
      const response = await api.put(`/deals/${editingDeal.id}`, dealData);
      setDeals(deals.map(d => d.id === editingDeal.id ? response.data.deal : d));
      setEditingDeal(null);
      setError('');
    } catch (err) {
      console.error('Error updating deal:', err);
      // For demo, update local state
      setDeals(deals.map(d => d.id === editingDeal.id ? { ...d, ...dealData } : d));
      setEditingDeal(null);
    }
  };

  const handleDeleteDeal = async (dealId) => {
    if (!window.confirm('Are you sure you want to delete this deal?')) {
      return;
    }

    try {
      await api.delete(`/deals/${dealId}`);
      setDeals(deals.filter(d => d.id !== dealId));
      setError('');
    } catch (err) {
      console.error('Error deleting deal:', err);
      // For demo, remove from local state
      setDeals(deals.filter(d => d.id !== dealId));
    }
  };

  const groupedDeals = {
    qualified: deals.filter(d => d.stage === 'qualified'),
    demo: deals.filter(d => d.stage === 'demo'),
    proposal: deals.filter(d => d.stage === 'proposal'),
    negotiation: deals.filter(d => d.stage === 'negotiation'),
    closed_won: deals.filter(d => d.stage === 'closed_won')
  };

  const stages = [
    { id: 'qualified', label: 'Qualified' },
    { id: 'demo', label: 'Demo' },
    { id: 'proposal', label: 'Proposal' },
    { id: 'negotiation', label: 'Negotiation' },
    { id: 'closed_won', label: 'Closed Won' }
  ];

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-spinner">Loading deals...</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1>Deal Pipeline</h1>
          <p>Manage your sales opportunities</p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>
          + New Deal
        </button>
      </div>

      {error && (
        <div className="error-banner">
          {error}
        </div>
      )}

      <div className="pipeline-stats">
        <div className="stat-card">
          <div className="stat-value">{deals.length}</div>
          <div className="stat-label">Active Deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            ${deals.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0).toLocaleString()}
          </div>
          <div className="stat-label">Total Pipeline</div>
        </div>
      </div>

      <div className="pipeline-board">
        {stages.map(stage => (
          <div key={stage.id} className="pipeline-column">
            <div className="column-header">
              <h3>{stage.label}</h3>
              <span className="count">{groupedDeals[stage.id]?.length || 0}</span>
            </div>
            <div className="column-content">
              {groupedDeals[stage.id]?.map(deal => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  onEdit={() => setEditingDeal(deal)}
                  onDelete={() => handleDeleteDeal(deal.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {(showForm || editingDeal) && (
        <DealForm
          deal={editingDeal}
          accounts={accounts}
          onSubmit={editingDeal ? handleUpdateDeal : handleCreateDeal}
          onClose={() => {
            setShowForm(false);
            setEditingDeal(null);
          }}
        />
      )}
    </div>
  );
}

function DealCard({ deal, onEdit, onDelete }) {
  const account = deal.account || { name: 'Unknown Account' };
  
  return (
    <div className="deal-card">
      <div className="deal-card-header">
        <h4>{deal.name}</h4>
        <div className="deal-actions">
          <button onClick={onEdit} className="icon-btn" title="Edit">
            ✏️
          </button>
          <button onClick={onDelete} className="icon-btn" title="Delete">
            🗑️
          </button>
        </div>
      </div>
      <p className="deal-company">{account.name}</p>
      <p className="deal-value">${parseFloat(deal.value || 0).toLocaleString()}</p>
      <div className={`deal-health ${deal.health}`}>
        ● {deal.health}
      </div>
      <p className="deal-date">
        Close: {deal.expected_close_date ? new Date(deal.expected_close_date).toLocaleDateString() : 'Not set'}
      </p>
    </div>
  );
}

// Mock data functions (for demo when API is not available)
function getMockDeals() {
  return [
    {
      id: 1,
      name: 'Acme Corp Enterprise Deal',
      account: { name: 'Acme Corp' },
      value: 85000,
      stage: 'negotiation',
      health: 'healthy',
      expected_close_date: '2024-03-15',
      probability: 75
    },
    {
      id: 2,
      name: 'TechFlow Platform Upgrade',
      account: { name: 'TechFlow Industries' },
      value: 125000,
      stage: 'proposal',
      health: 'healthy',
      expected_close_date: '2024-03-20',
      probability: 65
    }
  ];
}

function getMockAccounts() {
  return [
    { id: 1, name: 'Acme Corp' },
    { id: 2, name: 'TechFlow Industries' },
    { id: 3, name: 'CloudScale Inc' },
    { id: 4, name: 'Quantum Labs' },
    { id: 5, name: 'BuildRight Co' }
  ];
}

// Other view components (unchanged)
function ActionsView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Your Action Feed</h1>
        <p>8 actions need your attention today</p>
      </div>
      <div className="placeholder-message">
        <p>Actions view - Coming soon</p>
      </div>
    </div>
  );
}


function ContactsView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Contacts</h1>
        <p>Manage relationships</p>
      </div>
      <div className="placeholder-message">
        <p>Contacts view - Coming soon</p>
      </div>
    </div>
  );
}

function EmailView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Email Center</h1>
        <p>Send and track emails</p>
      </div>
      <div className="placeholder-message">
        <p>Email center - Coming soon</p>
      </div>
    </div>
  );
}

function CalendarView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Calendar</h1>
        <p>Manage meetings</p>
      </div>
      <div className="placeholder-message">
        <p>Calendar view - Coming soon</p>
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
