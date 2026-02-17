import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import './TranscriptAnalysis.css';

function TranscriptAnalysis({ transcriptId, onClose }) {
  const [transcript, setTranscript] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (transcriptId) {
      fetchTranscript();
      // Poll for analysis completion if pending
      const interval = setInterval(() => {
        if (transcript?.analysis_status === 'analyzing' || transcript?.analysis_status === 'pending') {
          fetchTranscript();
        }
      }, 3000);

      return () => clearInterval(interval);
    }
  }, [transcriptId]);

  const fetchTranscript = async () => {
    try {
      // Use apiService instead of fetch
      const response = await apiService.transcripts.getById(transcriptId);
      setTranscript(response.data.transcript);
      setLoading(false);
    } catch (err) {
      console.error('Error:', err);
      setError(err.response?.data?.error?.message || err.message || 'Failed to fetch transcript');
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="transcript-analysis">
        <div className="loading-state">
          <div className="spinner-large"></div>
          <p>Loading analysis...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="transcript-analysis">
        <div className="error-state">
          <p>❌ {error}</p>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  const analysis = transcript?.analysis_result;
  const isPending = transcript?.analysis_status === 'pending' || transcript?.analysis_status === 'analyzing';

  return (
    <div className="transcript-analysis-modal">
      <div className="modal-overlay" onClick={onClose}></div>
      
      <div className="modal-content large">
        <div className="modal-header">
          <div>
            <h2>🤖 Meeting Intelligence</h2>
            {transcript.meeting_title && (
              <p className="subtitle">{transcript.meeting_title}</p>
            )}
          </div>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Analysis Status */}
          {isPending && (
            <div className="analysis-status analyzing">
              <div className="spinner"></div>
              <span>AI is analyzing transcript... This may take 30-60 seconds.</span>
            </div>
          )}

          {transcript.analysis_status === 'failed' && (
            <div className="analysis-status failed">
              <span>❌ Analysis failed. Please try again.</span>
            </div>
          )}

          {transcript.analysis_status === 'completed' && analysis && (
            <>
              {/* Summary */}
              {analysis.summary && (
                <div className="analysis-section">
                  <h3>📋 Summary</h3>
                  <p className="summary-text">{analysis.summary}</p>
                </div>
              )}

              {/* Key Points */}
              {analysis.keyPoints && analysis.keyPoints.length > 0 && (
                <div className="analysis-section">
                  <h3>💡 Key Discussion Points</h3>
                  <ul className="key-points-list">
                    {analysis.keyPoints.map((point, idx) => (
                      <li key={idx}>{point}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Concerns */}
              {analysis.concerns && analysis.concerns.length > 0 && (
                <div className="analysis-section">
                  <h3>⚠️ Customer Concerns</h3>
                  <div className="concerns-list">
                    {analysis.concerns.map((concern, idx) => (
                      <div key={idx} className={`concern-item severity-${concern.severity}`}>
                        <div className="concern-header">
                          <span className="severity-badge">{concern.severity}</span>
                          {concern.addressed && <span className="addressed-badge">✓ Addressed</span>}
                        </div>
                        <p>{concern.concern}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Commitments */}
              {analysis.commitments && (
                <div className="analysis-section">
                  <h3>🤝 Commitments</h3>
                  <div className="commitments-grid">
                    {analysis.commitments.us && analysis.commitments.us.length > 0 && (
                      <div className="commitment-group">
                        <h4>Our Commitments</h4>
                        <ul>
                          {analysis.commitments.us.map((item, idx) => (
                            <li key={idx}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.commitments.customer && analysis.commitments.customer.length > 0 && (
                      <div className="commitment-group">
                        <h4>Customer Commitments</h4>
                        <ul>
                          {analysis.commitments.customer.map((item, idx) => (
                            <li key={idx}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Action Items */}
              {analysis.actionItems && analysis.actionItems.length > 0 && (
                <div className="analysis-section highlight">
                  <h3>✅ Action Items (Auto-Created)</h3>
                  <div className="action-items-list">
                    {analysis.actionItems.map((action, idx) => (
                      <div key={idx} className={`action-item priority-${action.priority}`}>
                        <div className="action-header">
                          <span className="priority-badge">{action.priority}</span>
                          <span className="owner-badge">{action.owner}</span>
                          {action.dueDate && (
                            <span className="due-date">Due: {new Date(action.dueDate).toLocaleDateString()}</span>
                          )}
                        </div>
                        <p>{action.description}</p>
                      </div>
                    ))}
                  </div>
                  <p className="info-note">
                    ℹ️ Actions for "us" have been automatically added to your Actions tab
                  </p>
                </div>
              )}

              {/* Deal Health */}
              {analysis.dealHealthSignals && (
                <div className="analysis-section">
                  <h3>💊 Deal Health Assessment</h3>
                  <div className={`health-status ${analysis.dealHealthSignals.overallHealth}`}>
                    <span className="health-icon">
                      {analysis.dealHealthSignals.overallHealth === 'healthy' && '✅'}
                      {analysis.dealHealthSignals.overallHealth === 'watch' && '⚠️'}
                      {analysis.dealHealthSignals.overallHealth === 'risk' && '🔴'}
                    </span>
                    <span className="health-label">
                      {analysis.dealHealthSignals.overallHealth.toUpperCase()}
                    </span>
                  </div>
                  {analysis.dealHealthSignals.reasoning && (
                    <p className="health-reasoning">{analysis.dealHealthSignals.reasoning}</p>
                  )}
                  <div className="health-signals">
                    {analysis.dealHealthSignals.positive && analysis.dealHealthSignals.positive.length > 0 && (
                      <div className="signals positive">
                        <h4>✅ Positive Signals</h4>
                        <ul>
                          {analysis.dealHealthSignals.positive.map((signal, idx) => (
                            <li key={idx}>{signal}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.dealHealthSignals.negative && analysis.dealHealthSignals.negative.length > 0 && (
                      <div className="signals negative">
                        <h4>⚠️ Risk Factors</h4>
                        <ul>
                          {analysis.dealHealthSignals.negative.map((signal, idx) => (
                            <li key={idx}>{signal}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Next Steps */}
              {analysis.nextSteps && analysis.nextSteps.length > 0 && (
                <div className="analysis-section">
                  <h3>🎯 Recommended Next Steps</h3>
                  <ol className="next-steps-list">
                    {analysis.nextSteps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Confidence Score */}
              {analysis.confidence && (
                <div className="confidence-score">
                  <span>AI Confidence: {Math.round(analysis.confidence * 100)}%</span>
                </div>
              )}
            </>
          )}

          {/* Original Transcript (Collapsible) */}
          <details className="transcript-details">
            <summary>📄 View Original Transcript</summary>
            <div className="transcript-text">
              {transcript.transcript_text}
            </div>
          </details>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default TranscriptAnalysis;
