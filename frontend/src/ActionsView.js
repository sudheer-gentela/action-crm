import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import './ActionsView.css';

function ActionsView() {
  const [actions, setActions] = useState([]);
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    loadActions();
  }, []);

  const loadActions = async () => {
    try {
      setLoading(true);
      setError('');

      const [actionsRes, dealsRes, contactsRes, accountsRes] = await Promise.all([
        apiService.actions.getAll().catch(() => ({ data: { actions: mockData.actions } })),
        apiService.deals.getAll().catch(() => ({ data: { deals: mockData.deals } })),
        apiService.contacts.getAll().catch(() => ({ data: { contacts: mockData.contacts } })),
        apiService.accounts.getAll().catch(() => ({ data: { accounts: mockData.accounts } }))
      ]);

      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        deals: dealsRes.data.deals || dealsRes.data || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        emails: [],
        meetings: [],
        actions: actionsRes.data.actions || actionsRes.data || []
      });

      setActions(enrichedData.actions);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);
      setAccounts(enrichedData.accounts);

    } catch (err) {
      console.error('Error loading actions:', err);
      setError('Failed to load actions. Using sample data.');
      
      const enrichedData = enrichData({
        ...mockData,
        emails: [],
        meetings: []
      });
      
      setActions(enrichedData.actions);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);
      setAccounts(enrichedData.accounts);
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteAction = async (actionId) => {
    try {
      await apiService.actions.update(actionId, { completed: true });
      setActions(actions.filter(a => a.id !== actionId));
    } catch (err) {
      console.error('Error completing action:', err);
      setActions(actions.filter(a => a.id !== actionId));
    }
  };

  const handleDismissAction = async (actionId) => {
    if (!window.confirm('Are you sure you want to dismiss this action?')) {
      return;
    }

    try {
      await apiService.actions.delete(actionId);
      setActions(actions.filter(a => a.id !== actionId));
    } catch (err) {
      console.error('Error dismissing action:', err);
      setActions(actions.filter(a => a.id !== actionId));
    }
  };

  const filteredActions = actions.filter(action => {
    if (filter === 'all') return true;
    if (filter === 'high') return action.priority === 'high';
    if (filter === 'today') {
      const today = new Date().toDateString();
      return new Date(action.due_date).toDateString() === today;
    }
    if (filter === 'overdue') {
      return new Date(action.due_date) < new Date() && !action.completed;
    }
    return action.action_type === filter;
  });

  const groupedActions = {
    high: filteredActions.filter(a => a.priority === 'high'),
    medium: filteredActions.filter(a => a.priority === 'medium'),
    low: filteredActions.filter(a => a.priority === 'low')
  };

  const getActionCounts = () => {
    return {
      total: actions.length,
      high: actions.filter(a => a.priority === 'high').length,
      today: actions.filter(a => {
        const today = new Date().toDateString();
        return new Date(a.due_date).toDateString() === today;
      }).length,
      overdue: actions.filter(a => 
        new Date(a.due_date) < new Date() && !a.completed
      ).length
    };
  };

  const counts = getActionCounts();

  if (loading) {
    return (
      <div className="actions-view">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading actions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="actions-view">
      {/* Header */}
      <div className="actions-header">
        <div>
          <h1>Your Action Feed</h1>
          <p className="actions-subtitle">
            {counts.high} high priority • {counts.today} due today • {counts.overdue} overdue
          </p>
        </div>
      </div>

      {error && (
        <div className="info-banner">
          ℹ️ {error}
        </div>
      )}

      {/* Stats */}
      <div className="actions-stats">
        <div className="stat-card">
          <div className="stat-value">{counts.total}</div>
          <div className="stat-label">Total Actions</div>
        </div>
        <div className="stat-card high">
          <div className="stat-value">{counts.high}</div>
          <div className="stat-label">High Priority</div>
        </div>
        <div className="stat-card today">
          <div className="stat-value">{counts.today}</div>
          <div className="stat-label">Due Today</div>
        </div>
        <div className="stat-card overdue">
          <div className="stat-value">{counts.overdue}</div>
          <div className="stat-label">Overdue</div>
        </div>
      </div>

      {/* Filters */}
      <div className="actions-filters">
        <button
          className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All Actions
        </button>
        <button
          className={`filter-btn ${filter === 'high' ? 'active' : ''}`}
          onClick={() => setFilter('high')}
        >
          High Priority
        </button>
        <button
          className={`filter-btn ${filter === 'today' ? 'active' : ''}`}
          onClick={() => setFilter('today')}
        >
          Due Today
        </button>
        <button
          className={`filter-btn ${filter === 'overdue' ? 'active' : ''}`}
          onClick={() => setFilter('overdue')}
        >
          Overdue
        </button>
        <button
          className={`filter-btn ${filter === 'follow_up' ? 'active' : ''}`}
          onClick={() => setFilter('follow_up')}
        >
          Follow-ups
        </button>
        <button
          className={`filter-btn ${filter === 'meeting' ? 'active' : ''}`}
          onClick={() => setFilter('meeting')}
        >
          Meetings
        </button>
      </div>

      {/* Actions List */}
      {filteredActions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">✅</div>
          <h3>No actions to show</h3>
          <p>
            {filter === 'all' 
              ? "You're all caught up! No pending actions."
              : `No ${filter} actions found.`}
          </p>
        </div>
      ) : (
        <div className="actions-container">
          {/* High Priority */}
          {groupedActions.high.length > 0 && (
            <div className="actions-section">
              <h2 className="section-title high">
                🔴 High Priority ({groupedActions.high.length})
              </h2>
              <div className="actions-list">
                {groupedActions.high.map(action => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    onComplete={() => handleCompleteAction(action.id)}
                    onDismiss={() => handleDismissAction(action.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Medium Priority */}
          {groupedActions.medium.length > 0 && (
            <div className="actions-section">
              <h2 className="section-title medium">
                🟡 Medium Priority ({groupedActions.medium.length})
              </h2>
              <div className="actions-list">
                {groupedActions.medium.map(action => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    onComplete={() => handleCompleteAction(action.id)}
                    onDismiss={() => handleDismissAction(action.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Low Priority */}
          {groupedActions.low.length > 0 && (
            <div className="actions-section">
              <h2 className="section-title low">
                🟢 Low Priority ({groupedActions.low.length})
              </h2>
              <div className="actions-list">
                {groupedActions.low.map(action => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    onComplete={() => handleCompleteAction(action.id)}
                    onDismiss={() => handleDismissAction(action.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionCard({ action, onComplete, onDismiss }) {
  const getActionIcon = () => {
    switch (action.action_type) {
      case 'follow_up': return '📞';
      case 'meeting': return '📅';
      case 'email': return '✉️';
      case 'review': return '📋';
      case 'update': return '✏️';
      default: return '⚡';
    }
  };

  const getTimeUntilDue = () => {
    const now = new Date();
    const due = new Date(action.due_date);
    const diff = due - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    if (diff < 0) return 'Overdue';
    if (days === 0 && hours === 0) return 'Due now';
    if (days === 0) return `Due in ${hours}h`;
    if (days === 1) return 'Due tomorrow';
    return `Due in ${days} days`;
  };

  const isOverdue = new Date(action.due_date) < new Date();

  return (
    <div className={`action-card priority-${action.priority} ${isOverdue ? 'overdue' : ''}`}>
      <div className="action-card-header">
        <div className="action-icon">{getActionIcon()}</div>
        <div className="action-meta">
          <span className={`action-type ${action.action_type}`}>
            {action.action_type.replace('_', ' ')}
          </span>
          <span className={`action-time ${isOverdue ? 'overdue-text' : ''}`}>
            {getTimeUntilDue()}
          </span>
        </div>
      </div>

      <div className="action-content">
        <h3 className="action-title">{action.title}</h3>
        <p className="action-description">{action.description}</p>

        {action.suggested_action && (
          <div className="suggested-action">
            <strong>💡 Suggested:</strong> {action.suggested_action}
          </div>
        )}

        {/* Related Entity */}
        {action.deal && (
          <div className="action-entity">
            <span className="entity-icon">💼</span>
            <span className="entity-name">{action.deal.name}</span>
            {action.deal.account && (
              <span className="entity-company"> • {action.deal.account.name}</span>
            )}
          </div>
        )}

        {action.contact && (
          <div className="action-entity">
            <span className="entity-icon">👤</span>
            <span className="entity-name">
              {action.contact.first_name} {action.contact.last_name}
            </span>
            {action.contact.account && (
              <span className="entity-company"> • {action.contact.account.name}</span>
            )}
          </div>
        )}
      </div>

      <div className="action-card-footer">
        <button className="btn-complete" onClick={onComplete}>
          ✓ Complete
        </button>
        <button className="btn-dismiss" onClick={onDismiss}>
          ✕ Dismiss
        </button>
      </div>
    </div>
  );
}

export default ActionsView;
