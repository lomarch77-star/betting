import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { StoreProvider } from './state/StoreProvider';
import './styles.css';

// The service worker is what makes this installable and offline-capable.
// `registerSW` is a no-op in dev unless PWA dev options are enabled.
registerSW({ immediate: true });

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
