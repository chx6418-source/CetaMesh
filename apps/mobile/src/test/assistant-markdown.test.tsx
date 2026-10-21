import React from 'react';
import Renderer, {act} from 'react-test-renderer';
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

test('separates a model-authored search preamble without claiming a tool actually ran', () => {
  expect(splitProcessPreamble('> 联网搜索：今日热点\n\n# 今日热点\n\n结果')).toEqual({process: '联网搜索：今日热点', answer: '# 今日热点\n\n结果'});
  expect(splitProcessPreamble('Agent → web_search(今日热点)\n\n# 今日热点')).toEqual({process: 'Agent → web_search(今日热点)', answer: '# 今日热点'});
  expect(splitProcessPreamble('# 正常回答\n\n内容')).toEqual({answer: '# 正常回答\n\n内容'});
});
