import React from 'react';
export function AppViewport({ children }: { children: React.ReactNode }) {
  return <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%',
    height: '100dvh', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>{children}</div>;
}
