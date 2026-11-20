import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { enableMapSet, setAutoFreeze } from 'immer';
import App from './App.tsx';
import './styles.css';

enableMapSet();
setAutoFreeze(false);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
