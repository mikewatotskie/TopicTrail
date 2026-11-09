import React, { createContext, useContext, useState } from 'react';
export interface StudySelection { documentId: string; text: string; page: number }
const Context = createContext<{ selection: StudySelection | null; setSelection: (value: StudySelection) => void } | null>(null);
export function StudySelectionProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<StudySelection | null>(null);
  return <Context.Provider value={{ selection, setSelection }}>{children}</Context.Provider>;
}
export function useStudySelection() {
  const value = useContext(Context);
  if (!value) throw new Error('StudySelectionProvider is missing');
  return value;
}
