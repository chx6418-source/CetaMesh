import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import AppBootstrap from '../app/bootstrap/AppBootstrap';
import MobileApp from '../app/bootstrap/MobileApp';
import {CetaError} from '../shared/errors/CetaError';
import type {MobileServices} from '../runtime/session/MobileServices';

test('renders the mobile bootstrap identity and phase', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<AppBootstrap />);
  });

  const output = renderer?.toJSON();
  const renderedText = JSON.stringify(output);

  expect(renderedText).toContain('CetaMesh Mobile');
  expect(renderedText).toContain('M0 Bootstrap');
});

test('renders a structured CetaError for bootstrap failures', async () => {
  const error = new CetaError('storage_error', 'Database unavailable');
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<AppBootstrap error={error} />);
  });

  const renderedText = JSON.stringify(renderer?.toJSON());

  expect(renderedText).toContain('storage_error');
  expect(renderedText).toContain('Database unavailable');
});

test('mobile startup exposes an accessible progress state while services initialize', async () => {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  const load = () => new Promise<MobileServices>(() => undefined);

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<MobileApp load={load} />);
  });

  const output = JSON.stringify(renderer.toJSON());
  expect(renderer.root.findAllByProps({testID: 'mobile-app-loading'}).length).toBeGreaterThan(0);
  expect(output).toContain('"accessibilityRole":"progressbar"');
  expect(output).toContain('正在准备工作区…');
  await ReactTestRenderer.act(() => renderer.unmount());
});
