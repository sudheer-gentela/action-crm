import React, { useState } from 'react';
import { apiService } from './apiService';
import './TranscriptUpload.css';

function TranscriptUpload({ dealId, onSuccess, onClose }) {
  const [uploadMethod, setUploadMethod] = useState('paste'); // 'paste' or 'file'
  const [transcriptText, setTranscriptText] = useState('');
  const [file, setFile] = useState(null);
  const [meetingDate, setMeetingDate] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      if (selectedFile.size > 5 * 1024 * 1024) {
        setError('File is too large. Maximum size is 5MB.');
        return;
      }
      setFile(selectedFile);
      setError('');
    }
  };

  const handleUpload = async () => {
    try {
      setUploading(true);
      setError('');

      // Validate
      if (uploadMethod === 'paste' && !transcriptText.trim()) {
        setError('Please enter a transcript');
        setUploading(false);
        return;
      }

      if (uploadMethod === 'file' && !file) {
        setError('Please select a file');
        setUploading(false);
        return;
      }

      const formData = new FormData();

      if (uploadMethod === 'file') {
        formData.append('file', file);
      } else {
        formData.append('text', transcriptText);
      }

      if (dealId) {
        formData.append('dealId', dealId);
      }

      if (meetingDate) {
        formData.append('meetingDate', meetingDate);
      }

      // Use apiService instead of fetch
      const response = await apiService.transcripts.upload(formData);
      const result = response.data;

      if (!result.success) {
        throw new Error(result.message || 'Upload failed');
      }

      // Success!
      if (onSuccess) {
        onSuccess(result);
      }

      // Reset form
      setTranscriptText('');
      setFile(null);
      setMeetingDate('');

    } catch (err) {
      console.error('Upload error:', err);
      setError(err.response?.data?.error?.message || err.message || 'Failed to upload transcript');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="transcript-upload-modal">
      <div className="modal-overlay" onClick={onClose}></div>
      
      <div className="modal-content">
        <div className="modal-header">
          <h2>📝 Upload Meeting Transcript</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Upload Method Selector */}
          <div className="upload-method-selector">
            <button
              className={`method-btn ${uploadMethod === 'paste' ? 'active' : ''}`}
              onClick={() => setUploadMethod('paste')}
            >
              ✍️ Paste Text
            </button>
            <button
              className={`method-btn ${uploadMethod === 'file' ? 'active' : ''}`}
              onClick={() => setUploadMethod('file')}
            >
              📄 Upload File
            </button>
          </div>

          {/* Paste Text Method */}
          {uploadMethod === 'paste' && (
            <div className="upload-section">
              <label>Meeting Transcript</label>
              <textarea
                className="transcript-textarea"
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.target.value)}
                placeholder="Paste your meeting transcript here...

Example:
[00:00] John: Thanks for joining. Let's discuss the proposal.
[00:15] Sarah: Yes, we're interested but have budget concerns.
[01:30] John: We can offer a phased approach...
[03:00] Sarah: That could work. Can you send details by Friday?
[03:15] John: Absolutely. I'll email the revised proposal."
                rows={15}
              />
              <div className="char-count">
                {transcriptText.length} characters
                {transcriptText.length > 0 && transcriptText.length < 50 && (
                  <span className="warning"> (minimum 50 required)</span>
                )}
              </div>
            </div>
          )}

          {/* File Upload Method */}
          {uploadMethod === 'file' && (
            <div className="upload-section">
              <label>Select .txt File</label>
              <div className="file-upload-area">
                <input
                  type="file"
                  accept=".txt"
                  onChange={handleFileChange}
                  id="transcript-file"
                  className="file-input"
                />
                <label htmlFor="transcript-file" className="file-upload-label">
                  {file ? (
                    <>
                      <span className="file-icon">📄</span>
                      <span className="file-name">{file.name}</span>
                      <span className="file-size">
                        ({(file.size / 1024).toFixed(1)} KB)
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="upload-icon">📁</span>
                      <span>Click to select .txt file or drag here</span>
                      <span className="upload-hint">Maximum size: 5MB</span>
                    </>
                  )}
                </label>
              </div>
            </div>
          )}

          {/* Optional: Meeting Date */}
          <div className="upload-section">
            <label>Meeting Date (Optional)</label>
            <input
              type="date"
              value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
              className="date-input"
            />
          </div>

          {/* AI Processing Info */}
          <div className="info-box">
            <span className="info-icon">🤖</span>
            <div className="info-content">
              <strong>AI will extract:</strong>
              <ul>
                <li>Key discussion points</li>
                <li>Customer concerns & objections</li>
                <li>Commitments made (by both sides)</li>
                <li>Action items (auto-created in CRM)</li>
                <li>Deal health signals</li>
                <li>Recommended next steps</li>
              </ul>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="error-message">
              ⚠️ {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="btn-secondary"
            onClick={onClose}
            disabled={uploading}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleUpload}
            disabled={uploading}
          >
            {uploading ? (
              <>
                <span className="spinner"></span>
                Uploading & Analyzing...
              </>
            ) : (
              <>
                🚀 Upload & Analyze
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TranscriptUpload;
