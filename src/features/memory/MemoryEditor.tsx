import {tr} from '../../shared/i18n';
import React, {useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {memoryKinds} from '../../domain/memory/Memory';
import type {MemoryKind, MemoryRecord, MemorySource} from '../../domain/memory/Memory';
import type {MemoryRuntime} from '../../runtime/memory/MemoryRuntime';
import {ErrorNotice, Field, safeError, ui} from '../../shared/ui/Controls';
import {Button, Card, Chip} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';

const kindLabels: Record<MemoryKind, string> = {
  working: tr('Working'),
  chat: tr('Chat'),
  user: tr('User'),
  task: tr('Task'),
  local: tr('Local'),
};

export function MemorySourceLabel({source}: {source: MemorySource}) {
  const label = source.kind === 'manual'
    ? tr('Saved manually')
    : source.kind === 'task'
      ? `From task · ${source.taskId}`
      : `From chat · ${source.sessionId} · ${source.messageIds.length} source message${source.messageIds.length === 1 ? '' : 's'}`;
  return <Text selectable style={styles.sourceLabel}>{label}</Text>;
}

export function MemoryEditor({
  memory,
  record,
  onBack,
  onSaved,
}: {
  memory: MemoryRuntime;
  record?: MemoryRecord;
  onBack: () => void;
  onSaved: (record: MemoryRecord) => void;
}) {
  const [content, setContent] = useState(record?.content ?? '');
  const [kind, setKind] = useState<MemoryKind>(record?.kind ?? 'local');
  const [importance, setImportance] = useState(String(record?.importance ?? 0.5));
  const [confidence, setConfidence] = useState(String(record?.confidence ?? 0.5));
  const [qualityOpen, setQualityOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof safeError>>();
  const pending = useRef(false);

  const save = async () => {
    if (pending.current) {return;}
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const input = {
        kind,
        content,
        importance: importance.trim() ? Number(importance) : NaN,
        confidence: confidence.trim() ? Number(confidence) : NaN,
      };
      const saved = record
        ? await memory.update(record.id, input, record.revision)
        : await memory.save(input);
      onSaved(saved);
    } catch (nextError) {
      setError(safeError(nextError));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Button title={tr('Cancel')} variant="subtle" testID="memory-list" disabled={busy} onPress={onBack} />
      <View style={styles.titleBlock}>
        <Text style={styles.eyebrow}>{record ? tr('UPDATE YOUR MEMORY') : tr('SAVE A NEW MEMORY')}</Text>
        <Text style={ui.title}>{record ? tr('Edit memory') : 'New memory'}</Text>
        <Text style={ui.text}>{tr('Saved on this device. It will only be used in a chat when you choose it.')}</Text>
      </View>

      <Card style={styles.formCard}>
        <Text style={styles.label}>{tr('Memory type')}</Text>
        <View style={styles.chips}>
          {memoryKinds.map(value => (
            <Chip
              key={value}
              label={kindLabels[value]}
              selected={kind === value}
              testID={`memory-kind-${value}`}
              disabled={busy}
              onPress={() => setKind(value)}
            />
          ))}
        </View>
        <View style={styles.contentField}>
          <Text style={styles.label}>{tr('What should CetaMesh remember?')}</Text>
          <TextInput
            testID="memory-content"
            accessibilityLabel={tr('Memory content')}
            accessibilityHint="Write a detail to keep on this device"
            style={styles.contentInput}
            multiline
            textAlignVertical="top"
            editable={!busy}
            placeholder={tr('A preference, useful detail, or task context…')}
            placeholderTextColor={colors.textMuted}
            value={content}
            onChangeText={setContent}
          />
        </View>
      </Card>

      <Button
        title={qualityOpen ? tr('Hide memory quality') : tr('Memory quality details')}
        variant="subtle"
        testID="memory-quality-toggle"
        onPress={() => setQualityOpen(open => !open)}
      />
      {qualityOpen ? (
        <Card style={styles.qualityCard}>
          <Text style={ui.text}>{tr('These values affect how memories are ranked in search.')}</Text>
          <Field
            label={tr('Importance (0–1)')}
            testID="memory-importance"
            value={importance}
            onChangeText={value => !busy && setImportance(value)}
          />
          <Field
            label={tr('Confidence (0–1)')}
            testID="memory-confidence"
            value={confidence}
            onChangeText={value => !busy && setConfidence(value)}
          />
        </Card>
      ) : null}

      {record ? (
        <Card style={styles.provenanceCard}>
          <Text style={styles.label}>{tr('Original source')}</Text>
          <MemorySourceLabel source={record.source} />
        </Card>
      ) : null}

      <ErrorNotice error={error} />
      <View style={styles.actions}>
        <Button title={tr('Save memory')} variant="primary" testID="memory-save" disabled={busy || !content.trim()} onPress={save} />
        <Button title={tr('Cancel')} variant="subtle" disabled={busy} onPress={onBack} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  titleBlock: {gap: space.sm, paddingVertical: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  formCard: {gap: space.md},
  label: {fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.text},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  contentField: {gap: space.sm},
  contentInput: {minHeight: 140, paddingHorizontal: space.md, paddingVertical: space.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.surface, color: colors.text, fontSize: 15, lineHeight: 22},
  qualityCard: {gap: space.md},
  provenanceCard: {gap: space.sm},
  sourceLabel: {fontSize: 12, lineHeight: 18, color: colors.textMuted},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
});
