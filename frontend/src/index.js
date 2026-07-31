import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
// Imported after App so that webpack emits it last in the stylesheet order and
// its rules win ties on specificity against App.css and the per-view CSS files.
import './mobile.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
