import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {Linking, Text} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {MarkdownIt} from 'react-native-markdown-display';
import {AssistantMarkdown, splitProcessPreamble} from '../features/chat/AssistantMarkdown';

test('completed answers render headings, lists, links, tables and copyable code as components', async () => {
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<AssistantMarkdown content={'# 今日热点\n\n**科技**\n\n- 事件 A\n\n| 来源 | 标题 |\n| --- | --- |\n| [1] | 新闻 |\n\n```ts\nconst x = 1;\n```'} />);
  });
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('今日热点');
  expect(output).toContain('事件 A');
  expect(output).toContain('来源');
  expect(view.root.findAllByProps({testID: 'code-copy'}).length).toBeGreaterThan(0);
  await act(async () => view.unmount());
});

test('assistant Markdown preserves typography, safe links and exact code copying after parser upgrades', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const copy = jest.spyOn(Clipboard, 'setString');
  let view!: Renderer.ReactTestRenderer;
  try {
    await act(async () => {
      view = Renderer.create(<AssistantMarkdown content={'"hello"\n\n[Source](https://example.com/news)\n\n[Blocked](javascript:alert(1))\n\n<b>literal HTML</b>\n\n```js\nconst value = "exact";\n```'} />);
    });
    const output = JSON.stringify(view.toJSON());
    expect(output).toContain('“hello”');
    expect(output).toContain('<b>literal HTML</b>');
    const links = view.root.findAllByType(Text).filter(node => typeof node.props.onPress === 'function');
    expect(links).toHaveLength(1);
    await act(async () => links[0].props.onPress());
    expect(openURL).toHaveBeenCalledWith('https://example.com/news');
    await act(async () => view.root.findAllByProps({testID: 'code-copy'})[0].props.onPress());
    expect(copy).toHaveBeenCalledWith('const value = "exact";');
  } finally {
    if (view) { await act(async () => view.unmount()); }
    openURL.mockRestore();
    copy.mockRestore();
  }
});

test('the assistant parser handles the unmatched smartquote denial-of-service fixture promptly', () => {
  // GHSA-r7fv-28h4-cvq7: the renderer enables typography on model-authored text.
  // The old parser took 24.5 seconds for this fixture; allow a wide CI margin.
  const parser = MarkdownIt({typographer: true});
  const input = '"a '.repeat(65536) + "b' ".repeat(65536);
  const start = performance.now();
  const tokens = parser.parse(input, {});
  expect(performance.now() - start).toBeLessThan(2000);
  expect(tokens.find((token: {type: string; content: string}) => token.type === 'inline')?.content).toBe(input.trimEnd());
});

test('separates a model-authored search preamble without claiming a tool actually ran', () => {
  expect(splitProcessPreamble('> 联网搜索：今日热点\n\n# 今日热点\n\n结果')).toEqual({process: '联网搜索：今日热点', answer: '# 今日热点\n\n结果'});
  expect(splitProcessPreamble('Agent → web_search(今日热点)\n\n# 今日热点')).toEqual({process: 'Agent → web_search(今日热点)', answer: '# 今日热点'});
  expect(splitProcessPreamble('# 正常回答\n\n内容')).toEqual({answer: '# 正常回答\n\n内容'});
});
