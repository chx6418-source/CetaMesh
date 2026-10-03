import {tr} from '../../shared/i18n';
import React, {useState} from 'react';
import {Alert, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {ChatSession} from '../../domain/chat/ChatRepository';
import type {MemoryRecord} from '../../domain/memory/Memory';
import type {MobileServices} from '../../runtime/session/MobileServices';
import {ErrorNotice, safeError, ui} from '../../shared/ui/Controls';
import {BottomSheet, Button, Card, EmptyState, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, space} from '../../shared/ui/tokens';
import {MemorySourceLabel} from './MemoryEditor';

export function MemoryDetailScreen({
  record,
  services,
  onBack,
  onEdit,
  onRecordChanged,
  onDeleted,
  onOpenChat,
  onUseInChat,
}: {
  record: MemoryRecord;
  services: MobileServices;
  onBack: () => void;
  onEdit: () => void;
  onRecordChanged: (record: MemoryRecord) => void;
  onDeleted: () => void;
  onOpenChat: (id: string) => void;
  onUseInChat: (sessionId: string | undefined, content: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof safeError>>();
  const [chatSheetOpen, setChatSheetOpen] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  const openChatPicker = async () => {
    setChatSheetOpen(true);
    setLoadingSessions(true);
    setError(undefined);
    try {
      setChatSessions(await services.sessions.list({archived: false, limit: 30}));
    } catch (nextError) {
      setError(safeError(nextError));
    } finally {
      setLoadingSessions(false);
    }
  };

  const openSourceChat = async (sessionId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await services.sessions.get(sessionId);
      onOpenChat(sessionId);
    } catch (nextError) {
      setError(safeError(nextError));
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onRecordChanged(await services.memory.pin(record.id, !record.pinned, record.revision));
    } catch (nextError) {
      setError(safeError(nextError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete memory?', 'This removes the saved note from this device.', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: tr('Delete'),
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setError(undefined);
          try {
            await services.memory.delete(record.id, record.revision);
            onDeleted();
          } catch (nextError) {
            setError(safeError(nextError));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const chooseSession = (sessionId?: string) => {
    setChatSheetOpen(false);
    onUseInChat(sessionId, record.content);
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Button title={tr('All memories')} variant="subtle" testID="memory-list" onPress={onBack} />
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>{tr('SAVED MEMORY')}</Text>
          <Text style={ui.title}>{tr('Memory details')}</Text>
        </View>

        <Card style={styles.contentCard}>
          <View style={styles.contentHeading}>
            <Text style={styles.sectionTitle}>{tr('Content')}</Text>
            {record.pinned ? <Text style={styles.pinnedBadge}>{tr('Pinned')}</Text> : null}
          </View>
          <Text selectable testID="memory-detail-content" style={styles.content}>
            {record.content}
          </Text>
        </Card>

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>{tr('Details')}</Text>
        </View>
        <Card style={styles.metadataCard}>
          <MetaRow label={tr('Type')} value={kindLabel(record.kind)} />
          <MetaRow label={tr('Scope')} value="Local only" testID="memory-scope" />
          <MetaRow label={tr('Source')} value={sourceKind(record)} />
          <MetaRow label={tr('Updated')} value={formatDate(record.updatedAt)} testID="memory-updated" />
          <MetaRow label={tr('Created')} value={formatDate(record.createdAt)} />
          <MetaRow label={tr('Importance')} value={`${Math.round(record.importance * 100)}%`} />
          <MetaRow label={tr('Confidence')} value={`${Math.round(record.confidence * 100)}%`} />
        </Card>

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>{tr('Provenance')}</Text>
        </View>
        <Card style={styles.provenanceCard}>
          <MemorySourceLabel source={record.source} />
          {record.source.kind === 'chat' ? (
            <>
              <MetaRow label={tr('Related session')} value={record.source.sessionId} />
              <MetaRow label={tr('Source messages')} value={`${record.source.messageIds.length} message${record.source.messageIds.length === 1 ? '' : 's'}`} />
              <Button
                title={tr('Open source chat')}
                variant="subtle"
                testID="memory-open-source-chat"
                disabled={busy}
                onPress={() => openSourceChat(record.source.kind === 'chat' ? record.source.sessionId : '')}
              />
            </>
          ) : record.source.kind === 'task' ? (
            <MetaRow label={tr('Related task')} value={record.source.taskId} />
          ) : (
            <Text style={ui.label}>{tr('Created manually in this memory library.')}</Text>
          )}
        </Card>

        <ErrorNotice error={error} />
        <View style={styles.actions}>
          <Button
            title={tr('Use in Chat')}
            variant="primary"
            testID="memory-use-in-chat"
            disabled={busy}
            onPress={openChatPicker}
          />
          <Button title={tr('Edit')} testID="memory-edit" disabled={busy} onPress={onEdit} />
          <Button
            title={record.pinned ? 'Unpin' : 'Pin'}
            variant="subtle"
            testID="memory-pin"
            disabled={busy}
            onPress={togglePin}
          />
          <Button
            title={busy ? 'Working…' : tr('Delete')}
            variant="danger"
            testID="memory-delete"
            disabled={busy}
            onPress={confirmDelete}
          />
        </View>
        {busy ? <LoadingState label={tr('Updating memory…')} style={styles.busyState} /> : null}
      </ScrollView>

      <BottomSheet
        visible={chatSheetOpen}
        title={tr('Choose a conversation')}
        onClose={() => setChatSheetOpen(false)}
        testIDPrefix="memory-use-chat-sheet">
        <Text style={ui.label}>{tr('This note will be added to an editable draft. Nothing is sent until you press Send.')}</Text>
        <ErrorNotice error={error} />
        {loadingSessions ? (
          <LoadingState label={tr('Loading conversations…')} style={styles.sheetLoading} />
        ) : null}
        {!loadingSessions && chatSessions.length ? (
          chatSessions.map(session => (
            <Card key={session.id} style={styles.sessionCard}>
              <Text numberOfLines={1} style={styles.sessionTitle}>{session.title}</Text>
              <Text style={ui.label}>{session.config.modelId || tr('Model not selected')}</Text>
              <Button
                title={tr('Use this conversation')}
                variant="subtle"
                testID={`memory-use-session-${session.id}`}
                onPress={() => chooseSession(session.id)}
              />
            </Card>
          ))
        ) : null}
        {!loadingSessions && !error && !chatSessions.length ? (
          <EmptyState
            title={tr('No active conversations')}
            description={tr('Start a new conversation to review this note before sending.')}
            style={styles.noSessionsCard}
          />
        ) : null}
        <Button title={tr('Start a new chat')} testID="memory-use-new-chat" onPress={() => chooseSession()} />
      </BottomSheet>
    </View>
  );
}

function MetaRow({label, value, testID}: {label: string; value: string; testID?: string}) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text testID={testID} selectable style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function kindLabel(kind: MemoryRecord['kind']) {
  const labels: Record<MemoryRecord['kind'], string> = {
    working: tr('Working'),
    chat: tr('Chat'),
    user: tr('User'),
    task: tr('Task'),
    local: tr('Local'),
  };
  return labels[kind];
}

function sourceKind(record: MemoryRecord) {
  if (record.source.kind === 'manual') {return tr('Saved manually');}
  return record.source.kind === 'task' ? tr('Task') : tr('Chat');
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? tr('Unknown') : date.toLocaleString();
}

const styles = StyleSheet.create({
  screen: {flex: 1, minHeight: 0},
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  titleBlock: {gap: space.xs, paddingVertical: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  contentCard: {gap: space.md},
  contentHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm},
  sectionTitle: {fontSize: 15, lineHeight: 21, fontWeight: '700', color: colors.text},
  content: {fontSize: 16, lineHeight: 25, color: colors.text},
  pinnedBadge: {fontSize: 11, lineHeight: 15, fontWeight: '700', color: colors.accent},
  sectionHeading: {marginTop: space.sm},
  metadataCard: {gap: space.md},
  provenanceCard: {gap: space.md},
  metaRow: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md},
  metaLabel: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  metaValue: {flexShrink: 1, textAlign: 'right', fontSize: 12, lineHeight: 17, fontWeight: '600', color: colors.text},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  sheetLoading: {minHeight: 72},
  busyState: {minHeight: 56},
  sessionCard: {gap: space.sm},
  sessionTitle: {fontSize: 14, lineHeight: 20, fontWeight: '700', color: colors.text},
  noSessionsCard: {gap: space.sm},
});
