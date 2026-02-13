import React, { useState, useEffect } from 'react';
import './ActionsView.css';

function ActionsView() {
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchActions();
  }, []);

  const fetchActions = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      const response = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}/actions`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch actions');
      }

      const data = await response.json();
      console.log('📊 Actions data:', data);
      setActions(data.actions || []);
    } catch (err) {
      console.error('Error fetching actions:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const formatActionType = (type) => {
    // ✅ SAFE: Handle undefined/null
    if (!type) return 'task';
    
    // Convert snake_case to Title Case
    return type
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  };

  const getPriorityColor = (priority) => {
    switch(priority) {
      case 'high': return '#ef4444';
      case 'medium': return '#f59e0b';
      case 'low': return '#10b981';
      default: return '#6b7280';
    }
  };

  const handleComplete = async (id) => {
    try {
      const token = localStorage.getItem('token');
      
      await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}/actions/${id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ completed: true })
      });

      fetchActions();
    } catch (err) {
      console.error('Error completing action:', err);
    }
  };

  const handleGenerateActions = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      const response = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}/actions/generate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const result = await response.json();
      alert(`Generated ${result.generated} actions, inserted ${result.inserted}!`);
      fetchActions();
    } catch (err) {
      console.error('Error generating actions:', err);
      alert('Failed to generate actions: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="actions-view">
        <div className="loading">Loading actions...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="actions-view">
        <div className="error">
          <p>Error: {error}</p>
          <button onClick={fetchActions}>Retry</button>
        </div>
      </div>
    );
  }

  const openActions = actions.filter(a => !a.completed);
  const completedActions = actions.filter(a => a.completed);

  return (
    <div className="actions-view">
      <div className="actions-header">
        <h2>⚡ Actions ({openActions.length} open)</h2>
        <button onClick={handleGenerateActions} className="btn btn-primary">
          Generate Actions
        </button>
      </div>

      {openActions.length === 0 && (
        <div className="empty-state">
          <p>No open actions</p>
          <button onClick={handleGenerateActions} className="btn btn-primary">
            Generate Actions
          </button>
        </div>
      )}

      <div className="actions-list">
        {openActions.map(action => (
          <div key={action.id} className="action-card">
            <div className="action-header">
              <span 
                className="action-type"
                style={{ 
                  backgroundColor: getPriorityColor(action.priority) + '20',
                  color: getPriorityColor(action.priority)
                }}
              >
                {formatActionType(action.type || action.actionType || action.action_type)}
              </span>
              <span 
                className="action-priority"
                style={{ color: getPriorityColor(action.priority) }}
              >
                {action.priority || 'medium'}
              </span>
            </div>

            <h3>{action.title || 'Untitled Action'}</h3>
            
            {action.description && (
              <p className="action-description">{action.description}</p>
            )}

            {action.suggestedAction && (
              <div className="suggested-action">
                <strong>💡 Suggestion:</strong> {action.suggestedAction}
              </div>
            )}

            {action.deal && (
              <div className="action-context">
                📊 {action.deal.name} ({action.deal.stage})
              </div>
            )}

            {action.contact && (
              <div className="action-context">
                👤 {action.contact.firstName} {action.contact.lastName}
              </div>
            )}

            <div className="action-footer">
              {action.dueDate && (
                <span className="due-date">
                  Due: {new Date(action.dueDate).toLocaleDateString()}
                </span>
              )}
              <button 
                onClick={() => handleComplete(action.id)}
                className="btn btn-small btn-success"
              >
                ✓ Complete
              </button>
            </div>
          </div>
        ))}
      </div>

      {completedActions.length > 0 && (
        <div className="completed-section">
          <h3>✅ Completed ({completedActions.length})</h3>
          <div className="actions-list">
            {completedActions.map(action => (
              <div key={action.id} className="action-card completed">
                <h4>{action.title}</h4>
                <span className="completed-date">
                  Completed {new Date(action.completedAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ActionsView;
