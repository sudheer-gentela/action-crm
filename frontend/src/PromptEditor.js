import React, { useState, useEffect } from 'react';
import './PromptEditor.css';

function PromptEditor() {
  const [prompts, setPrompts] = useState({
    email_analysis: '',
    deal_health_check: ''
  });
  const [activeTab, setActiveTab] = useState('email_analysis');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadPrompts();
  }, []);

  const loadPrompts = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

      const response = await fetch(`${API_URL}/prompts`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to load prompts');
      }

      const data = await response.json();
      
      if (data.success && data.prompts) {
        setPrompts(data.prompts);
      }
    } catch (error) {
      console.error('Error loading prompts:', error);
      setMessage('Failed to load prompts');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage('');
      const token = localStorage.getItem('token');
      const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

      const response = await fetch(`${API_URL}/prompts`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompts })
      });

      if (!response.ok) {
        throw new Error('Failed to save prompts');
      }

      const data = await response.json();
      
      if (data.success) {
        setMessage('✅ Prompts saved successfully!');
        setTimeout(() => setMessage(''), 3000);
      }
    } catch (error) {
      console.error('Error saving prompts:', error);
      setMessage('❌ Failed to save prompts');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm('Reset to default prompts? Your customizations will be lost.')) {
      return;
    }

    try {
      setSaving(true);
      setMessage('');
      const token = localStorage.getItem('token');
      const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

      const response = await fetch(`${API_URL}/prompts/reset`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to reset prompts');
      }

      const data = await response.json();
      
      if (data.success && data.prompts) {
        setPrompts(data.prompts);
        setMessage('✅ Prompts reset to defaults!');
        setTimeout(() => setMessage(''), 3000);
      }
    } catch (error) {
      console.error('Error resetting prompts:', error);
      setMessage('❌ Failed to reset prompts');
    } finally {
      setSaving(false);
    }
  };

  const handlePromptChange = (value) => {
    setPrompts({
      ...prompts,
      [activeTab]: value
    });
  };

  if (loading) {
    return (
      <div className="prompt-editor">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading prompts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="prompt-editor">
      <div className="prompt-header">
        <div>
          <h1>🤖 AI Prompt Templates</h1>
          <p className="prompt-subtitle">
            Customize how Claude analyzes your deals and emails
          </p>
        </div>
        <div className="header-actions">
          <button 
            className="btn-secondary" 
            onClick={handleReset}
            disabled={saving}
          >
            Reset to Defaults
          </button>
          <button 
            className="btn-primary" 
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {message && (
        <div className={`message ${message.includes('✅') ? 'success' : 'error'}`}>
          {message}
        </div>
      )}

      <div className="prompt-tabs">
        <button
          className={`tab ${activeTab === 'email_analysis' ? 'active' : ''}`}
          onClick={() => setActiveTab('email_analysis')}
        >
          📧 Email Analysis
        </button>
        <button
          className={`tab ${activeTab === 'deal_health_check' ? 'active' : ''}`}
          onClick={() => setActiveTab('deal_health_check')}
        >
          🏥 Deal Health Check
        </button>
      </div>

      <div className="prompt-content">
        <div className="prompt-info">
          <h3>
            {activeTab === 'email_analysis' ? '📧 Email Analysis Prompt' : '🏥 Deal Health Check Prompt'}
          </h3>
          <p className="info-text">
            {activeTab === 'email_analysis' 
              ? 'This prompt analyzes incoming emails with full conversation context (email threads, meetings, deal history) to generate intelligent actions.'
              : 'This prompt performs comprehensive deal health checks, analyzing all interactions to identify risks and opportunities.'}
          </p>
          
          <div className="placeholder-guide">
            <h4>Available Placeholders:</h4>
            <div className="placeholder-list">
              <code>DEAL_NAME_PLACEHOLDER</code>
              <code>DEAL_STAGE_PLACEHOLDER</code>
              <code>DEAL_VALUE_PLACEHOLDER</code>
              <code>CONTACT_NAME_PLACEHOLDER</code>
              <code>ACCOUNT_NAME_PLACEHOLDER</code>
              <code>EMAIL_THREAD_PLACEHOLDER</code>
              <code>MEETINGS_PLACEHOLDER</code>
              <code>DEAL_HISTORY_PLACEHOLDER</code>
            </div>
            <p className="placeholder-note">
              These placeholders are automatically replaced with real data when AI runs.
            </p>
          </div>
        </div>

        <div className="prompt-editor-container">
          <textarea
            className="prompt-textarea"
            value={prompts[activeTab] || ''}
            onChange={(e) => handlePromptChange(e.target.value)}
            placeholder="Enter your AI prompt template..."
            spellCheck={false}
          />
          <div className="editor-footer">
            <span className="character-count">
              {(prompts[activeTab] || '').length} characters
            </span>
          </div>
        </div>
      </div>

      <div className="prompt-tips">
        <h4>💡 Tips for Effective Prompts:</h4>
        <ul>
          <li>Be specific about what information to extract and analyze</li>
          <li>Include clear instructions for JSON output format</li>
          <li>Specify priority criteria (what makes an action high vs medium priority)</li>
          <li>Give examples of good vs bad outputs</li>
          <li>Use placeholders for dynamic data (they'll be replaced at runtime)</li>
          <li>Test changes on a few deals before relying on them in production</li>
        </ul>
      </div>
    </div>
  );
}

export default PromptEditor;
