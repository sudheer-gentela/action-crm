import React, { useState } from 'react';
import { apiService } from './apiService';
import './TranscriptUpload.css';

function TranscriptUpload({ dealId, onSuccess, onClose }) {
  const [uploadMethod, setUploadMethod] = useState('paste');
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

      if (dealId) formData.append('dealId', dealId);
      if (meetingDate) formData.append('meetingDate', meetingDate);

      const response = await apiService.transcripts.upload(formData);
      const result = response.data;

      if (!result.success) {
        throw new Error(result.message || 'Upload failed');
      }

      if (onSuccess) onSuccess(result);

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
      <div className="tu-overlay" onClick={onClose}></div>

      <div className="tu-content">
        <div className="tu-header">
          <h2>📝 Upload Meeting Transcript</h2>
          <button className="tu-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="tu-body">
          {/* Method Selector */}
          <div className="tu-method-selector">
            <button
              className={`tu-method-btn ${uploadMethod === 'paste' ? 'active' : ''}`}
              onClick={() => setUploadMethod('paste')}
            >
              ✍️ Paste Text
            </button>
            <button
              className={`tu-method-btn ${uploadMethod === 'file' ? 'active' : ''}`}
              onClick={() => setUploadMethod('file')}
            >
              📄 Upload File
            </button>
          </div>

          {/* Paste Text */}
          {uploadMethod === 'paste' && (
            <div className="tu-section">
              <label>Meeting Transcript</label>
              <textarea
                className="tu-textarea"
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.target.value)}
                placeholder={`Paste your meeting transcript here...\n\nExample:\n[00:00] John: Thanks for joining. Let's discuss the proposal.\n[00:15] Sarah: Yes, we're interested but have budget concerns.\n[01:30] John: We can offer a phased approach...`}
                rows={15}
              />
              <div className="tu-char-count">
                {transcriptText.length} characters
                {transcriptText.length > 0 && transcriptText.length < 50 && (
                  <span className="tu-warning"> (minimum 50 required)</span>
                )}
              </div>
            </div>
          )}

          {/* File Upload */}
          {uploadMethod === 'file' && (
            <div className="tu-section">
              <label>Select .txt File</label>
              <div className="tu-file-area">
                <input
                  type="file"
                  accept=".txt"
                  onChange={handleFileChange}
                  id="transcript-file"
                  className="tu-file-input"
                />
                <label htmlFor="transcript-file" className="tu-file-label">
                  {file ? (
                    <>
                      <span className="tu-file-icon">📄</span>
                      <span className="tu-file-name">{file.name}</span>
                      <span className="tu-file-size">({(file.size / 1024).toFixed(1)} KB)</span>
                    </>
                  ) : (
                    <>
                      <span className="tu-upload-icon">📁</span>
                      <span>Click to select .txt file or drag here</span>
                      <span className="tu-upload-hint">Maximum size: 5MB</span>
                    </>
                  )}
                </label>
              </div>
            </div>
          )}

          {/* Meeting Date */}
          <div className="tu-section">
            <label>Meeting Date (Optional)</label>
            <input
              type="date"
              value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
              className="tu-date-input"
            />
          </div>

          {/* Info Box */}
          <div className="tu-info-box">
            <span className="tu-info-icon">🤖</span>
            <div className="tu-info-content">
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

          {/* Error */}
          {error && (
            <div className="tu-error">⚠️ {error}</div>
          )}
        </div>

        <div className="tu-footer">
          <button className="tu-btn-secondary" onClick={onClose} disabled={uploading}>
            Cancel
          </button>
          <button className="tu-btn-primary" onClick={handleUpload} disabled={uploading}>
            {uploading ? (
              <>
                <span className="tu-spinner"></span>
                Uploading & Analyzing...
              </>
            ) : (
              <>🚀 Upload & Analyze</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TranscriptUpload;
