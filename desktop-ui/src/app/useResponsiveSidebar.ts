import { useEffect, useState } from 'react';

const compactQuery = '(max-width: 1100px)';

export function useResponsiveSidebar(page: string, chatMode = 'chat') {
  const location = page === 'chat' ? `${page}:${chatMode}` : page;
  const initialCollapsed = () => page !== 'chat' || chatMode !== 'chat' || typeof window !== 'undefined' && window.matchMedia(compactQuery).matches;
  const [state, setState] = useState(() => ({ location, collapsed: initialCollapsed() }));
  // Adjust only for navigation, before children commit. Data refreshes retain
  // the user's manual choice, and non-Chat never paints an expanded first frame.
  const collapsed = state.location === location ? state.collapsed : initialCollapsed();
  if (state.location !== location) setState({ location, collapsed });
  useEffect(() => {
    const compact = window.matchMedia(compactQuery);
    const collapse = () => { if (compact.matches) setState(current => ({ ...current, collapsed: true })); };
    compact.addEventListener('change', collapse);
    return () => compact.removeEventListener('change', collapse);
  }, []);
  return { collapsed, toggle: () => setState({ location, collapsed: !collapsed }) };
}
