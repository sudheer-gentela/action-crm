import React, { useState, useEffect } from 'react';
import './App.css';

// Simple authentication check
const useAuth = () => {
  const [user, setUser] = useState(null);
  
  useEffect(() => {
    const token = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (token && userData) {
      setUser(JSON.parse(userData));
    }
  }, []);
  
  const login = (email, password) => {
    // Simple mock login for demo
    const mockUser = { id: 1, email, name: 'Demo User' };
    localStorage.setItem('token', 'demo-token');
    localStorage.setItem('user', JSON.stringify(mockUser));
    setUser(mockUser);
  };
  
  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };
  
  return { user, login, logout };
};

// Login Screen
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  
  const handleSubmit = (e) => {
    e.preventDefault();
    if (email && password) {
      onLogin(email, password);
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
            />
          </div>
          
          <button type="submit" className="btn-primary">
            Sign In
          </button>
        </form>
        
        <div className="demo-info">
          <p>🎉 <strong>Demo Mode</strong> - Use any email/password to explore</p>
        </div>
        
        <div className="deployment-info">
          <p><strong>Backend API:</strong></p>
          <code>{process.env.REACT_APP_API_URL || 'Not configured - set REACT_APP_API_URL'}</code>
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

// Actions View
function ActionsView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Your Action Feed</h1>
        <p>8 actions need your attention today</p>
      </div>
      
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">8</div>
          <div className="stat-label">Open Actions</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">12</div>
          <div className="stat-label">Active Deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">$423K</div>
          <div className="stat-label">Pipeline</div>
        </div>
      </div>
      
      <div className="action-list">
        <ActionItem 
          title="Follow up with Sarah Chen - Acme Corp"
          type="email"
          priority="high"
          deal="Acme Corp Enterprise ($85K)"
        />
        <ActionItem 
          title="Prepare for TechFlow executive presentation"
          type="meeting"
          priority="high"
          deal="TechFlow Enterprise Platform ($125K)"
        />
        <ActionItem 
          title="Send proposal to CloudScale Inc"
          type="proposal"
          priority="medium"
          deal="CloudScale Platform ($65K)"
        />
      </div>
    </div>
  );
}

function ActionItem({ title, type, priority, deal }) {
  return (
    <div className={`action-item priority-${priority}`}>
      <div className="action-icon">{type === 'email' ? '✉️' : type === 'meeting' ? '📅' : '📄'}</div>
      <div className="action-content">
        <h3>{title}</h3>
        <p className="action-deal">{deal}</p>
      </div>
      <div className="action-actions">
        <button className="btn-small">Take Action</button>
      </div>
    </div>
  );
}

// Deals View
function DealsView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Deal Pipeline</h1>
        <p>Visual pipeline with AI health scoring</p>
      </div>
      
      <div className="pipeline-board">
        <PipelineColumn title="Qualified" count={3} />
        <PipelineColumn title="Demo" count={4} />
        <PipelineColumn title="Proposal" count={2} />
        <PipelineColumn title="Negotiation" count={2} />
        <PipelineColumn title="Closed Won" count={1} />
      </div>
    </div>
  );
}

function PipelineColumn({ title, count }) {
  return (
    <div className="pipeline-column">
      <div className="column-header">
        <h3>{title}</h3>
        <span className="count">{count}</span>
      </div>
      <div className="column-content">
        {title === 'Negotiation' && (
          <div className="deal-card">
            <h4>TechFlow Enterprise Platform</h4>
            <p className="deal-company">TechFlow Industries</p>
            <p className="deal-value">$125,000</p>
            <div className="deal-health good">● Good Health</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Accounts View
function AccountsView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Accounts</h1>
        <p>Manage company accounts and opportunities</p>
      </div>
      
      <div className="accounts-grid">
        <AccountCard name="Acme Corp" industry="Technology" deals={1} value="$85K" />
        <AccountCard name="TechFlow Industries" industry="Manufacturing" deals={1} value="$125K" />
        <AccountCard name="CloudScale Inc" industry="SaaS" deals={1} value="$65K" />
      </div>
    </div>
  );
}

function AccountCard({ name, industry, deals, value }) {
  return (
    <div className="account-card">
      <div className="account-icon">{name.substring(0, 2).toUpperCase()}</div>
      <h3>{name}</h3>
      <p className="account-industry">{industry}</p>
      <div className="account-stats">
        <div><strong>{deals}</strong> Deals</div>
        <div><strong>{value}</strong> Pipeline</div>
      </div>
    </div>
  );
}

// Contacts View
function ContactsView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Contacts</h1>
        <p>Manage relationships and engagement</p>
      </div>
      
      <div className="contacts-list">
        <ContactItem name="Sarah Chen" title="VP Product" company="Acme Corp" />
        <ContactItem name="David Martinez" title="CTO" company="TechFlow Industries" />
        <ContactItem name="Michael Rodriguez" title="CEO" company="CloudScale Inc" />
      </div>
    </div>
  );
}

function ContactItem({ name, title, company }) {
  return (
    <div className="contact-item">
      <div className="contact-avatar">{name.split(' ').map(n => n[0]).join('')}</div>
      <div className="contact-info">
        <h3>{name}</h3>
        <p>{title} at {company}</p>
      </div>
    </div>
  );
}

// Email View
function EmailView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Email Center</h1>
        <p>Send, track, and manage sales emails</p>
      </div>
      
      <div className="email-container">
        <div className="email-sidebar">
          <button className="btn-primary">✉️ Compose</button>
          <div className="email-folders">
            <div className="email-folder active">📥 Inbox (12)</div>
            <div className="email-folder">📤 Sent (45)</div>
            <div className="email-folder">📊 Tracked (28)</div>
          </div>
        </div>
        <div className="email-list">
          <EmailItem 
            from="Sarah Chen - Acme Corp" 
            subject="Re: Demo Follow-up"
            preview="Thanks for the great demo yesterday..."
            status="opened"
          />
        </div>
      </div>
    </div>
  );
}

function EmailItem({ from, subject, preview, status }) {
  return (
    <div className="email-item">
      <h4>{from}</h4>
      <p className="email-subject">{subject}</p>
      <p className="email-preview">{preview}</p>
      <span className={`email-status ${status}`}>{status === 'opened' ? '✓ Opened' : '⏳ Pending'}</span>
    </div>
  );
}

// Calendar View
function CalendarView() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Calendar</h1>
        <p>Manage meetings and appointments</p>
      </div>
      
      <div className="calendar-grid">
        <div className="calendar-day">
          <h4>Monday</h4>
          <div className="meeting-card">
            <div className="meeting-time">2:00 PM</div>
            <div className="meeting-title">TechFlow Executive Presentation</div>
          </div>
        </div>
        <div className="calendar-day">
          <h4>Tuesday</h4>
          <div className="meeting-card">
            <div className="meeting-time">10:00 AM</div>
            <div className="meeting-title">Acme Corp Demo</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Main App Component
function App() {
  const { user, login, logout } = useAuth();
  
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
