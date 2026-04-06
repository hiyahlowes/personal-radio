import { createContext, useContext, type ReactNode } from 'react';
import { useV4V, type V4VContextValue } from '@/hooks/useV4V';

const V4VContext = createContext<V4VContextValue | null>(null);

export function V4VProvider({ children }: { children: ReactNode }) {
  const v4v = useV4V();
  return <V4VContext.Provider value={v4v}>{children}</V4VContext.Provider>;
}

export function useV4VContext(): V4VContextValue {
  const ctx = useContext(V4VContext);
  if (!ctx) throw new Error('useV4VContext must be used inside V4VProvider');
  return ctx;
}
