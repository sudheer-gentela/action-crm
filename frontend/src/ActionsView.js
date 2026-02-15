import React, { useState, useEffect } from 'react';
import './ActionsView.css';

function ActionsView() {
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterType, setFilterType] = useState('all'); // ✅ ADDED: Filter state

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
    if (!type) return 'task';
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

  // ✅ ADDED: Filter actions based on type
  const openActions = actions.filter(a => {
    if (a.completed) return false;
    if (filterType === 'all') return true;
    if (filterType === 'ai') return a.source === 'ai_generated';
    if (filterType === 'rules') return a.source === 'auto_generated';
    return true;
  });
  
  const completedActions = actions.filter(a => a.completed);

  // ✅ ADDED: Count AI actions
  const aiCount = actions.filter(a => !a.completed && a.source === 'ai_generated').length;
  const rulesCount = actions.filter(a => !a.completed && a.source === 'auto_generated').length;

  return (
    <div className="actions-view">
      <div className="actions-header">
        <h2>⚡ Actions ({openActions.length} open)</h2>
        <button onClick={handleGenerateActions} className="btn btn-primary">
          Generate Actions
        </button>
      </div>

      {/* ✅ ADDED: Filter buttons */}
      <div className="actions-filters">
        <button 
          className={`filter-btn ${filterType === 'all' ? 'active' : ''}`}
          onClick={() => setFilterType('all')}
        >
          All ({actions.filter(a => !a.completed).length})
        </button>
        <button 
          className={`filter-btn ${filterType === 'ai' ? 'active' : ''}`}
          onClick={() => setFilterType('ai')}
        >
          🤖 AI Generated ({aiCount})
        </button>
        <button 
          className={`filter-btn ${filterType === 'rules' ? 'active' : ''}`}
          onClick={() => setFilterType('rules')}
        >
          ⚙️ Rule-Based ({rulesCount})
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
              
              {/* ✅ ADDED: AI Badge */}
              {action.source === 'ai_generated' && (
                <span 
                  className="ai-badge"
                  title={`AI Confidence: ${action.metadata?.confidence ? Math.round(action.metadata.confidence * 100) + '%' : 'N/A'}`}
                >
                  🤖 AI
                </span>
              )}
              
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

            {/* ✅ ADDED: Show AI Context (why this action was created) */}
            {action.context && action.source === 'ai_generated' && (
              <div className="ai-context">
                <strong>💡 AI Insight:</strong> {action.context}
              </div>
            )}

            {/* ✅ ENHANCED: Better styling for suggested action */}
            {action.suggestedAction && (
              <div className="suggested-action">
                <strong>📋 {action.source === 'ai_generated' ? 'AI Recommendation:' : 'Suggestion:'}</strong> {action.suggestedAction}
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

            {/* ✅ ADDED: Show confidence score for AI actions */}
            {action.metadata?.confidence && action.source === 'ai_generated' && (
              <div className="ai-confidence">
                Confidence: {Math.round(action.metadata.confidence * 100)}%
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
