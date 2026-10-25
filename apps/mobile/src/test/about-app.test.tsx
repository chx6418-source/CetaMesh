import React from 'react';
import {NativeModules, Text} from 'react-native';
import Renderer, {act} from 'react-test-renderer';
import {AboutAppScreen} from '../features/about/AboutAppScreen';
import {installedAppVersion} from '../providers/appinfo/AppInfo';
import {unconfiguredUpdateService, type UpdateAnnouncement, type UpdateService} from '../domain/update/UpdateService';

test('reads the installed Android version rather than a JS hardcoded version', () => {
  const previous = NativeModules.CetaAppInfo;
  NativeModules.CetaAppInfo = {versionName: '2.4.7'};
  expect(installedAppVersion()).toBe('2.4.7');
  NativeModules.CetaAppInfo = previous;
});

test('about app exposes author, real version and honest update states', async () => {
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<AboutAppScreen version="2.4.7" onBack={() => undefined} />);});
  expect(JSON.stringify(view.toJSON())).toContain('chx6418-source');
  expect(JSON.stringify(view.toJSON())).toContain('2.4.7');

  await act(async () => view.root.findByProps({testID: 'check-update'}).props.onPress());
  expect(JSON.stringify(view.toJSON())).toContain('更新服务暂未开放');
  expect(view.root.findByProps({accessibilityLiveRegion: 'polite'})).toBeTruthy();
  expect(() => view.root.findByProps({accessibilityRole: 'status'})).toThrow();

  await act(async () => view.root.findByProps({testID: 'download-update'}).props.onPress());
  expect(JSON.stringify(view.toJSON())).toContain('更新服务暂未开放');
  expect(view.root.findByProps({accessibilityLiveRegion: 'polite'})).toBeTruthy();
  expect(() => view.root.findByProps({accessibilityRole: 'status'})).toThrow();

  await act(async () => view.root.findByProps({testID: 'release-notes'}).props.onPress());
  expect(JSON.stringify(view.toJSON())).toContain('暂无更新公告');
  await act(async () => view.unmount());

  expect(await unconfiguredUpdateService.checkForUpdate()).toEqual({status: 'unconfigured'});
  expect(await unconfiguredUpdateService.getLatestVersion()).toBeUndefined();
  expect(await unconfiguredUpdateService.downloadUpdate()).toBeUndefined();
});

test('update announcements do not repeat a version already shown in the title', async () => {
  const notes: UpdateAnnouncement[] = [
    {version: '1.1.0', title: 'CetaMesh 1.1.0', publishedAt: '2026-10-03', content: '测试版本不代表发布版本。', importance: 'feature'},
    {version: '1.2.0', title: 'Beta 3', publishedAt: '2026-10-02', content: '修复若干问题。', importance: 'fix'},
  ];
  const service: UpdateService = {
    ...unconfiguredUpdateService,
    getLatestVersion: async () => '1.1.0',
    getReleaseNotes: async () => notes,
  };

  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<AboutAppScreen version="1.0" onBack={() => undefined} updates={service} />);});
  await act(async () => view.root.findByProps({testID: 'release-notes'}).props.onPress());

  const titles = view.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
  expect(titles).toContain('CetaMesh 1.1.0');
  expect(titles).toContain('Beta 3 · 1.2.0');
  expect(titles.filter(title => title === 'CetaMesh 1.1.0 · 1.1.0')).toEqual([]);
  await act(async () => view.unmount());
});
