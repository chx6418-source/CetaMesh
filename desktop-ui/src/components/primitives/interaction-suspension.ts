import {createContext} from 'react';

// Presentation-only suspension. It does not grant or revoke Core capabilities.
// Portals keep React context even when their DOM is outside the normal app root.
export const InteractionSuspensionContext = createContext(false);
