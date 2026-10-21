/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App, {appStatusBarProps} from '../App';
import {colors} from '../src/shared/ui/tokens';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
  expect(appStatusBarProps).toEqual({barStyle: 'dark-content', backgroundColor: colors.surface});
});
