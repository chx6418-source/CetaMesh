import React from 'react';
import {NativeModules} from 'react-native';
import Renderer, {act} from 'react-test-renderer';
import {AboutAppScreen} from '../features/about/AboutAppScreen';
import {installedAppVersion} from '../providers/appinfo/AppInfo';
import {unconfiguredUpdateService} from '../domain/update/UpdateService';

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
  expect(JSON.stringify(view.toJSON())).toContain('暂未发现可用发布版本');
  expect(view.root.findByProps({accessibilityLiveRegion: 'polite'})).toBeTruthy();
  expect(() => view.root.findByProps({accessibilityRole: 'status'})).toThrow();

  await act(async () => view.root.findByProps({testID: 'download-update'}).props.onPress());
  expect(JSON.stringify(view.toJSON())).toContain('暂无可下载的 APK 更新包');
  expect(view.root.findByProps({accessibilityLiveRegion: 'polite'})).toBeTruthy();
  expect(() => view.root.findByProps({accessibilityRole: 'status'})).toThrow();

  await act(async () => view.root.findByProps({testID: 'release-notes'}).props.onPress());
  expect(JSON.stringify(view.toJSON())).toContain('暂无更新公告');
  await act(async () => view.unmount());

  expect(await unconfiguredUpdateService.checkForUpdate()).toEqual({status: 'unavailable'});
  expect(await unconfiguredUpdateService.getLatestVersion()).toBeUndefined();
  expect(await unconfiguredUpdateService.downloadUpdate()).toBeUndefined();
});
