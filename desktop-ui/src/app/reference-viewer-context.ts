import { createContext, useContext } from 'react';
import type { PreviewSource } from '../bridge/typed-client';

export const ReferenceViewerContext = createContext<{ open(source: PreviewSource, label: string, trigger: HTMLElement): void } | null>(null);
export const useReferenceViewer = () => useContext(ReferenceViewerContext);
