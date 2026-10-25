import { useEffect, useState } from 'react';

const compactQuery = '(max-width: 1100px)';

export function useResponsiveSidebar(page: string) {
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactQuery).matches);
  useEffect(() => {
    const compact = window.matchMedia(compactQuery);
    const collapse = () => { if (compact.matches) setCollapsed(true); };
    compact.addEventListener('change', collapse);
    return () => compact.removeEventListener('change', collapse);
  }, []);
  useEffect(() => {
    if (window.matchMedia(compactQuery).matches) setCollapsed(true);
  }, [page]);
  return { collapsed, toggle: () => setCollapsed(current => !current) };
}
