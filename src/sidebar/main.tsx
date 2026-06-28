import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarController } from './Controller';
import { SidebarProvider } from './state';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root mount point');

createRoot(root).render(
  <StrictMode>
    <SidebarProvider>
      <SidebarController />
    </SidebarProvider>
  </StrictMode>,
);
