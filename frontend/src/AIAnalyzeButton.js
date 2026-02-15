import React, { useState } from 'react';
import './AIAnalyzeButton.css';

/**
 * Reusable AI Analyze Button Component
 * Can be used in DealsView, EmailView, OutlookEmailList, etc.
 */
function AIAnalyzeButton({ type, id, onSuccess }) {
  const [loading, setLoading] = useState(false);

  const handleAnalyze = async () => {
    try {
      setLoading(true);

      const token = localStorage.getItem('token');
      const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

      const endpoint = type === 'deal' 
        ? `${API_URL}/ai/deal/${id}`
        : `${API_URL}/ai/email/${id}`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('AI analysis failed');
      }

      const result = await response.json();

      if (result.success) {
        const count = result.actions?.length || 0;
        alert(`✨ AI generated ${count} intelligent action${count !== 1 ? 's' : ''}!`);
        
        // Call parent callback if provided
        if (onSuccess) {
          onSuccess(result);
        }
      } else {
        throw new Error(result.error || 'Analysis failed');
      }

    } catch (err) {
      console.error('AI analysis error:', err);
      alert(`❌ AI analysis failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className={`ai-analyze-btn ${loading ? 'loading' : ''}`}
      onClick={handleAnalyze}
      disabled={loading}
      title="Analyze with AI - generates intelligent actions based on full context"
    >
      {loading ? (
        <>
          <span className="ai-spinner">⟳</span>
          Analyzing...
        </>
      ) : (
        <>
          🤖 AI Analyze
        </>
      )}
    </button>
  );
}

export default AIAnalyzeButton;
