import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Developer console for a running Honey server (quotes, markets, sign-in). Not deployed:
// the public website is apps/web.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
