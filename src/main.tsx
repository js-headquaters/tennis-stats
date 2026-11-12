import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './app/App';
import { registerUpdateController } from './app/pwa';
import { createPwaUpdateController } from './app/pwaUpdate';
import './styles/tokens.css';
import './styles/global.css';

// Must run before the first render: AppShell reads getUpdateController() while rendering.
registerUpdateController(createPwaUpdateController({ registerSW }));

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
