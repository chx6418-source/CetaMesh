import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {ErrorNotice} from '../shared/ui/Controls';
import {Button, EmptyState, LoadingState} from '../shared/ui/DesignSystem';
import {CetaError} from '../shared/errors/CetaError';

test('shared loading state is announced as progress with a useful label', async () => {
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <LoadingState label="Loading tasks…" testID="tasks-loading" />,
    );
  });

  const progress = view.root.findAll(node =>
    node.props.testID === 'tasks-loading' && node.props.accessibilityRole === 'progressbar',
  )[0]!;
  expect(progress.props.accessibilityRole).toBe('progressbar');
  expect(progress.props.accessibilityLabel).toBe('Loading tasks…');
  expect(JSON.stringify(view.toJSON())).toContain('Loading tasks…');
  await act(async () => view.unmount());
});

test('shared empty state gives its heading semantics and keeps a primary action', async () => {
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <EmptyState
        icon="✓"
        title="No tasks yet"
        description="Tasks you create will collect here."
        testID="tasks-empty">
        <Button title="Create task" onPress={() => undefined} />
      </EmptyState>,
    );
  });

  expect(view.root.findByProps({testID: 'tasks-empty'})).toBeDefined();
  expect(view.root.findByProps({accessibilityRole: 'header'}).props.children).toBe('No tasks yet');
  expect(JSON.stringify(view.toJSON())).toContain('Create task');
  await act(async () => view.unmount());
});

test('offline errors use clear retry guidance and announce the change', async () => {
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <ErrorNotice error={new CetaError('network_unavailable', 'Network request failed')} />,
    );
  });

  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('网络不可用，请连接后重试。');
  expect(output).not.toContain('network_unavailable');
  expect(view.root.findByProps({testID: 'error-notice'}).props.accessibilityLiveRegion).toBe('assertive');
  await act(async () => view.unmount());
});
