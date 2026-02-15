import React, { useState, useEffect } from 'react';
import './PlaybookEditor.css';

function PlaybookEditor() {
  const [playbook, setPlaybook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('company');

  useEffect(() => {
    fetchPlaybook();
  }, []);

  const fetchPlaybook = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${process.env.REACT_APP_API_URL}/playbook`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      const data = await response.json();
      setPlaybook(data.playbook);
    } catch (error) {
      console.error('Error loading playbook:', error);
    } finally {
      setLoading(false);
    }
  };

  const savePlaybook = async () => {
    try {
      setSaving(true);
      const token = localStorage.getItem('token');
      
      await fetch(`${process.env.REACT_APP_API_URL}/playbook`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ playbook })
      });

      alert('✅ Playbook saved successfully!');
    } catch (error) {
      alert('❌ Failed to save playbook');
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (path, value) => {
    setPlaybook(prev => {
      const updated = { ...prev };
      const keys = path.split('.');
      let current = updated;
      
      for (let i = 0; i < keys.length - 1; i++) {
        current = current[keys[i]];
      }
      
      current[keys[keys.length - 1]] = value;
      return updated;
    });
  };

  if (loading) {
    return <div className="playbook-editor loading">Loading playbook...</div>;
  }

  if (!playbook) {
    return <div className="playbook-editor error">Failed to load playbook</div>;
  }

  return (
    <div className="playbook-editor">
      <div className="editor-header">
        <h2>📘 Sales Playbook Editor</h2>
        <button 
          onClick={savePlaybook} 
          disabled={saving}
          className="btn btn-primary"
        >
          {saving ? 'Saving...' : '💾 Save Playbook'}
        </button>
      </div>

      <div className="editor-tabs">
        <button 
          className={activeTab === 'company' ? 'active' : ''}
          onClick={() => setActiveTab('company')}
        >
          🏢 Company Info
        </button>
        <button 
          className={activeTab === 'stages' ? 'active' : ''}
          onClick={() => setActiveTab('stages')}
        >
          📊 Deal Stages
        </button>
        <button 
          className={activeTab === 'roles' ? 'active' : ''}
          onClick={() => setActiveTab('roles')}
        >
          👥 Contact Roles
        </button>
        <button 
          className={activeTab === 'triggers' ? 'active' : ''}
          onClick={() => setActiveTab('triggers')}
        >
          ⚡ Email Triggers
        </button>
      </div>

      <div className="editor-content">
        {activeTab === 'company' && (
          <div className="section">
            <h3>Company Information</h3>
            
            <div className="form-group">
              <label>Company Name</label>
              <input
                type="text"
                value={playbook.company.name}
                onChange={(e) => updateField('company.name', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>Industry</label>
              <input
                type="text"
                value={playbook.company.industry}
                onChange={(e) => updateField('company.industry', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>Product Description</label>
              <textarea
                value={playbook.company.product}
                onChange={(e) => updateField('company.product', e.target.value)}
                rows={3}
              />
            </div>
          </div>
        )}

        {activeTab === 'stages' && (
          <div className="section">
            <h3>Deal Stages</h3>
            {Object.keys(playbook.deal_stages).map(stage => (
              <div key={stage} className="stage-card">
                <h4>{stage.replace('_', ' ').toUpperCase()}</h4>
                
                <div className="form-group">
                  <label>Goal</label>
                  <input
                    type="text"
                    value={playbook.deal_stages[stage].goal}
                    onChange={(e) => updateField(`deal_stages.${stage}.goal`, e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Next Step</label>
                  <input
                    type="text"
                    value={playbook.deal_stages[stage].next_step}
                    onChange={(e) => updateField(`deal_stages.${stage}.next_step`, e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Timeline</label>
                  <input
                    type="text"
                    value={playbook.deal_stages[stage].timeline}
                    onChange={(e) => updateField(`deal_stages.${stage}.timeline`, e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Email Response Time</label>
                  <input
                    type="text"
                    value={playbook.deal_stages[stage].email_response_time}
                    onChange={(e) => updateField(`deal_stages.${stage}.email_response_time`, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'roles' && (
          <div className="section">
            <h3>Contact Roles</h3>
            {Object.keys(playbook.contact_roles).map(role => (
              <div key={role} className="role-card">
                <h4>{role.replace('_', ' ').toUpperCase()}</h4>
                
                <div className="form-group">
                  <label>Priority</label>
                  <select
                    value={playbook.contact_roles[role].priority}
                    onChange={(e) => updateField(`contact_roles.${role}.priority`, e.target.value)}
                  >
                    <option value="highest">Highest</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Communication Style</label>
                  <input
                    type="text"
                    value={playbook.contact_roles[role].communication_style}
                    onChange={(e) => updateField(`contact_roles.${role}.communication_style`, e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Response Time</label>
                  <input
                    type="text"
                    value={playbook.contact_roles[role].response_time}
                    onChange={(e) => updateField(`contact_roles.${role}.response_time`, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'triggers' && (
          <div className="section">
            <h3>Email Triggers</h3>
            {Object.keys(playbook.email_triggers).map(trigger => (
              <div key={trigger} className="trigger-card">
                <h4>{trigger.replace('_', ' ').toUpperCase()}</h4>
                
                <div className="form-group">
                  <label>Urgency</label>
                  <select
                    value={playbook.email_triggers[trigger].urgency}
                    onChange={(e) => updateField(`email_triggers.${trigger}.urgency`, e.target.value)}
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Response Time</label>
                  <input
                    type="text"
                    value={playbook.email_triggers[trigger].response_time}
                    onChange={(e) => updateField(`email_triggers.${trigger}.response_time`, e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Action</label>
                  <input
                    type="text"
                    value={playbook.email_triggers[trigger].action}
                    onChange={(e) => updateField(`email_triggers.${trigger}.action`, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default PlaybookEditor;
