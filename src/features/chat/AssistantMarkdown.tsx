import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Markdown, {type RenderRules} from 'react-native-markdown-display';
import {Button} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';

const renderCode = (content: string, key: string) => (
  <View key={key} style={styles.codeBlock}>
    <Button title="复制" variant="subtle" testID="code-copy" style={styles.copyButton} onPress={() => Clipboard.setString(content.trimEnd())} />
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
      <Text selectable style={styles.codeText}>{content.trimEnd()}</Text>
    </ScrollView>
  </View>
);

const rules: RenderRules = {
  fence: node => renderCode(node.content, node.key),
  code_block: node => renderCode(node.content, node.key),
  table: (node, children) => <ScrollView key={node.key} horizontal nestedScrollEnabled style={styles.tableScroll}><View>{children}</View></ScrollView>,
};

export function AssistantMarkdown({content}: {content: string}) {
  return <Markdown rules={rules} style={markdownStyles}>{content}</Markdown>;
}

/** Model-authored preambles are separate from the answer, not verified tool events. */
export function splitProcessPreamble(content: string): {process?: string; answer: string} {
  const match = /^(?:>\s*)?((?:(?:联网搜索|搜索网络|读取记忆|调用工具)[：:].+|Agent\s*(?:→|->)\s*(?:web_search|memory|plugin|file|device|capability)\([^\r\n]*\)))(?:\r?\n){2,}/i.exec(content);
  return match ? {process: match[1].trim(), answer: content.slice(match[0].length)} : {answer: content};
}

const markdownStyles = StyleSheet.create({
  body: {fontSize: 16, lineHeight: 27, color: colors.text},
  paragraph: {marginTop: 0, marginBottom: 12, fontSize: 16, lineHeight: 27},
  heading1: {fontSize: 21, lineHeight: 30, fontWeight: '700', marginTop: 14, marginBottom: 9, color: colors.text},
  heading2: {fontSize: 18, lineHeight: 27, fontWeight: '700', marginTop: 12, marginBottom: 8, color: colors.text},
  heading3: {fontSize: 16, lineHeight: 25, fontWeight: '700', marginTop: 10, marginBottom: 6, color: colors.text},
  bullet_list: {marginBottom: 10}, ordered_list: {marginBottom: 10},
  list_item: {marginBottom: 5},
  blockquote: {backgroundColor: colors.surfaceMuted, borderLeftColor: colors.accent, borderLeftWidth: 3, paddingLeft: 12, marginBottom: 12},
  code_inline: {fontFamily: 'monospace', backgroundColor: colors.surfaceMuted, color: colors.text, borderRadius: 4},
  link: {color: colors.accent},
  hr: {backgroundColor: colors.border, height: 1, marginVertical: 14},
  table: {borderWidth: 1, borderColor: colors.border, marginVertical: 10},
  th: {padding: 8, borderColor: colors.border, borderWidth: 1},
  td: {padding: 8, borderColor: colors.border, borderWidth: 1},
});

const styles = StyleSheet.create({
  codeBlock: {backgroundColor: colors.surfaceMuted, borderRadius: radii.md, padding: space.sm, maxWidth: '100%', marginVertical: space.sm},
  copyButton: {alignSelf: 'flex-end', minHeight: 32, paddingVertical: 3},
  codeText: {fontFamily: 'monospace', fontSize: 13, lineHeight: 20, color: colors.text, padding: space.xs},
  tableScroll: {maxWidth: '100%'},
});
