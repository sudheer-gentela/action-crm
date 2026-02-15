import React, { useState, useEffect } from 'react';
import './App.css';
import AccountsView from './AccountsView';
import DealsView from './DealsView';
import ContactsView from './ContactsView';
import EmailView from './EmailView';
import ActionsView from './ActionsView';
import CalendarView from './CalendarView';
import OutlookConnect from './OutlookConnect';
import OutlookEmailList from './OutlookEmailList';
import SyncStatus from './SyncStatus';
import PlaybookEditor from './PlaybookEditor'; // ✅ ADDED

// ... (keep all your existing authentication code - useAuth, AuthScreen)

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
  
  // ✅ ADDED playbook tab
  const navItems = [
    { id: 'actions', label: 'Actions', icon: '🎯' },
    { id: 'deals', label: 'Deals', icon: '💼' },
    { id: 'accounts', label: 'Accounts', icon: '🏢' },
    { id: 'contacts', label: 'Contacts', icon: '👥' },
    { id: 'email', label: 'Email', icon: '✉️' },
    { id: 'outlook', label: 'Outlook Emails', icon: '📧' },
    { id: 'calendar', label: 'Calendar', icon: '📅' },
    { id: 'playbook', label: 'Sales Playbook', icon: '📘' } // ✅ ADDED THIS
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
          {currentTab === 'actions' && <ActionsView />}
          {currentTab === 'deals' && <DealsView />}
          {currentTab === 'accounts' && <AccountsView />}
          {currentTab === 'contacts' && <ContactsView />}
          {currentTab === 'email' && <EmailView />}
          {currentTab === 'outlook' && (
            <div className="outlook-view">
              <OutlookConnect />
              <SyncStatus />
              <OutlookEmailList />
            </div>
          )}
          {currentTab === 'calendar' && <CalendarView />}
          {currentTab === 'playbook' && <PlaybookEditor />} {/* ✅ ADDED THIS */}
        </div>
      </main>
    </div>
  );
}

// ... (keep the rest of your App component and export)
