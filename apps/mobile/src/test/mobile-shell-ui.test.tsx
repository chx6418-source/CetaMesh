import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {Keyboard, StyleSheet} from 'react-native';
import {
  BottomSheet,
  Button,
  Card,
  Chip,
  MobileShell,
} from '../shared/ui/DesignSystem';

test('mobile shell presents the four primary destinations and routes tab changes', async () => {
  const onTabChange = jest.fn();
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <MobileShell
        activeTab="chat"
        title="Chat"
        onTabChange={onTabChange}>
        <Card testID="shell-card">
          <Button title="Start a chat" onPress={() => undefined} />
        </Card>
      </MobileShell>,
    );
  });

  expect(JSON.stringify(view.toJSON())).toContain('工作区');
  for (const [id, label] of [['chat', '聊天'], ['tasks', '任务'], ['memory', '记忆'], ['workspace', '工作区']]) {
    expect(view.root.findByProps({testID: `tab-${id}`}).props.accessibilityLabel).toBe(label);
    expect(view.root.findByProps({testID: `tab-icon-${id}`})).toBeDefined();
  }
  expect(view.root.findByProps({testID: 'tab-chat'}).props.accessibilityState).toMatchObject({selected: true});
  expect(view.root.findByProps({testID: 'shell-card'})).toBeDefined();

  await act(async () => {
    view.root.findByProps({testID: 'tab-memory'}).props.onPress();
  });
  expect(onTabChange).toHaveBeenCalledWith('memory');
  await act(async () => view.unmount());
});

test('shared button and chip expose accessible selection and disabled state', async () => {
  const onChipPress = jest.fn();
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <>
        <Button title="Save" variant="primary" disabled testID="save" onPress={() => undefined} />
        <Chip label="Reasoning" selected onPress={onChipPress} testID="reasoning-chip" />
      </>,
    );
  });

  const saveButton = view.root
    .findAllByProps({testID: 'save'})
    .find(node => node.props.accessibilityRole === 'button');
  const reasoningChip = view.root
    .findAllByProps({testID: 'reasoning-chip'})
    .find(node => node.props.accessibilityRole === 'button');
  expect(saveButton?.props.accessibilityState).toMatchObject({disabled: true});
  expect(reasoningChip?.props.accessibilityState).toMatchObject({selected: true});
  await act(async () => view.root.findByProps({testID: 'reasoning-chip'}).props.onPress());
  expect(onChipPress).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
});

test('bottom sheet reports visibility and provides an accessible close control', async () => {
  const onClose = jest.fn();
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <BottomSheet visible title="Choose an attachment" onClose={onClose}>
        <Button title="Choose photo" onPress={() => undefined} />
      </BottomSheet>,
    );
  });

  expect(view.root.findByProps({testID: 'bottom-sheet-modal'}).props.visible).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain('Choose an attachment');
  await act(async () => view.root.findByProps({testID: 'bottom-sheet-close'}).props.onPress());
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
});

test('navigation and compact controls expose Android-friendly touch semantics', async () => {
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <>
        <MobileShell activeTab="chat" title="Chat" onTabChange={() => undefined}>
          <Card testID="shell-content">{null}</Card>
        </MobileShell>
        <Button title="Save" testID="target-button" onPress={() => undefined} />
        <Chip label="Reasoning" testID="target-chip" onPress={() => undefined} />
      </>,
    );
  });

  const nav = view.root.findAllByProps({accessibilityLabel: '主导航'})[0];
  expect(nav.props.accessibilityRole).toBe('tablist');
  const button = view.root.findAllByProps({testID: 'target-button'})
    .find(node => node.props.accessibilityRole === 'button')!;
  expect(StyleSheet.flatten(button.props.style({pressed: false})).minHeight).toBeGreaterThanOrEqual(44);
  const chip = view.root.findAllByProps({testID: 'target-chip'})
    .find(node => node.props.accessibilityRole === 'button')!;
  expect(chip.props.hitSlop).toMatchObject({top: 5, bottom: 5});

  await act(async () => view.unmount());
});

test('keyboard hides bottom navigation so the composer can use resized space', async () => {
  const callbacks: Record<string, () => void> = {};
  const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
    callbacks[event] = listener as () => void;
    return {remove: () => undefined};
  });
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<MobileShell activeTab="chat" title="聊天" onTabChange={() => undefined}>{null}</MobileShell>);});
  expect(view.root.findAllByProps({testID: 'tab-chat'}).length).toBeGreaterThan(0);
  await act(async () => callbacks.keyboardDidShow?.());
  expect(view.root.findAllByProps({testID: 'tab-chat'})).toHaveLength(0);
  await act(async () => callbacks.keyboardDidHide?.());
  expect(view.root.findAllByProps({testID: 'tab-chat'}).length).toBeGreaterThan(0);
  await act(async () => view.unmount());
  spy.mockRestore();
});
