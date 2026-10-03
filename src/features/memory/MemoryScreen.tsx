import {tr} from '../../shared/i18n';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {memoryKinds} from '../../domain/memory/Memory';
import type {MemoryKind, MemoryRecord} from '../../domain/memory/Memory';
import type {MobileServices} from '../../runtime/session/MobileServices';
import {ErrorNotice, Field, safeError, ui} from '../../shared/ui/Controls';
import {Button, Card, Chip, EmptyState, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';
import {MemoryDetailScreen} from './MemoryDetailScreen';
import {MemoryEditor} from './MemoryEditor';

const kindLabels: Record<MemoryKind, string> = {
  working: tr('Working'),
  chat: tr('Chat'),
  user: tr('User'),
  task: tr('Task'),
  local: tr('Local'),
};

export function MemoryScreen({
  services,
  onOpenChat,
  onUseInChat,
}: {
  services: MobileServices;
  onOpenChat: (id: string) => void;
  onUseInChat: (sessionId: string | undefined, content: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MemoryKind>();
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [selected, setSelected] = useState<MemoryRecord>();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ReturnType<typeof safeError>>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const version = useRef(0);
  const pagePending = useRef(false);

  const reload = useCallback(async () => {
    const request = ++version.current;
    setLoading(true);
    setError(undefined);
    try {
      const list = await services.memory.search({query, kind, limit: 30});
      if (request === version.current) {
        setRecords(list);
        setHasMore(list.length === 30);
      }
    } catch (nextError) {
      if (request === version.current) {
        setError(safeError(nextError));
      }
    } finally {
      if (request === version.current) {
        setLoading(false);
      }
    }
  }, [services, query, kind]);

  useEffect(() => {
    const currentVersion = version;
    reload();
    const unsubscribe = services.memory.subscribe(() => reload());
    return () => {
      currentVersion.current++;
      unsubscribe();
    };
  }, [services, reload]);

  if (selected && editing) {
    return (
      <MemoryEditor
        key={`edit:${selected.id}`}
        record={selected}
        memory={services.memory}
        onBack={() => setEditing(false)}
        onSaved={record => {
          setSelected(record);
          setEditing(false);
          reload();
        }}
      />
    );
  }

  if (creating) {
    return (
      <MemoryEditor
        key="create"
        memory={services.memory}
        onBack={() => setCreating(false)}
        onSaved={record => {
          setSelected(record);
          setCreating(false);
          reload();
        }}
      />
    );
  }

  if (selected) {
    return (
      <MemoryDetailScreen
        key={selected.id}
        record={selected}
        services={services}
        onBack={() => setSelected(undefined)}
        onEdit={() => setEditing(true)}
        onRecordChanged={record => {
          setSelected(record);
          reload();
        }}
        onDeleted={() => {
          setSelected(undefined);
          reload();
        }}
        onOpenChat={onOpenChat}
        onUseInChat={onUseInChat}
      />
    );
  }

  const changeQuery = (value: string) => {
    if (value === query) {return;}
    version.current++;
    setRecords([]);
    setLoading(true);
    setQuery(value);
  };

  const changeKind = (value?: MemoryKind) => {
    if (value === kind) {return;}
    version.current++;
    setRecords([]);
    setLoading(true);
    setKind(value);
  };

  const empty = !loading && !error && records.length === 0;

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled">
      <View style={styles.intro}>
        <Text style={styles.eyebrow}>{tr('YOUR NOTES AND CONTEXT')}</Text>
        <Text style={ui.title}>{tr('Memory')}</Text>
        <Text style={ui.text}>{tr('A private library of details you chose to keep.')}</Text>
      </View>

      <View style={styles.libraryHeading}>
        <View style={styles.libraryCopy}>
          <Text style={styles.libraryTitle}>{tr('Saved memories')}</Text>
          <Text style={ui.label}>Stored on this device · never added to a chat automatically</Text>
        </View>
        <Button
          title={tr('New memory')}
          variant="secondary"
          testID="memory-new"
          onPress={() => setCreating(true)}
        />
      </View>

      <Field
        label={tr('Search memories')}
        testID="memory-search"
        value={query}
        onChangeText={changeQuery}
      />

      <View style={styles.filterHeader}>
        <Text style={styles.filterTitle}>{tr('Browse by type')}</Text>
        <Text style={ui.label}>
          {loading
            ? 'Loading…'
            : error && !records.length
              ? tr('Memory list unavailable')
              : `${records.length}${hasMore ? '+' : ''} shown`}
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        <Chip
          label={tr('Recent')}
          selected={kind === undefined}
          testID="memory-filter-recent"
          onPress={() => changeKind(undefined)}
        />
        {memoryKinds.map(value => (
          <Chip
            key={value}
            label={kindLabels[value]}
            selected={kind === value}
            testID={`memory-filter-${value}`}
            onPress={() => changeKind(value)}
          />
        ))}
      </ScrollView>

      <ErrorNotice error={error} />
      {loading ? (
        <LoadingState label={tr('Loading memories…')} testID="memory-loading" />
      ) : null}
      {empty ? (
        <EmptyState
          testID="memory-empty-state"
          icon="M"
          title={query || kind ? tr('No matching memories') : tr('Nothing saved yet')}
          description={query || kind
            ? tr('Try another search or browse a different memory type.')
            : tr('Save a useful detail here and decide when to use it in a conversation.')}
        >
          {query || kind ? (
            <Button
              title={tr('Clear search and filters')}
              variant="subtle"
              testID="memory-clear-filters"
              onPress={() => {
                changeQuery('');
                changeKind(undefined);
              }}
            />
          ) : (
            <Button title={tr('Create a memory')} testID="memory-empty-create" onPress={() => setCreating(true)} />
          )}
        </EmptyState>
      ) : null}

      {records.map(record => (
        <Pressable
          key={record.id}
          accessibilityRole="button"
          accessibilityLabel={`${kindLabels[record.kind]} memory${record.pinned ? ', pinned' : ''}`}
          testID={`memory-${record.id}`}
          onPress={() => setSelected(record)}
          style={({pressed}) => [styles.recordPressable, pressed && styles.pressed]}>
          <Card style={styles.recordCard}>
            <View style={styles.recordHeading}>
              <View style={styles.recordHeadingCopy}>
                <Text style={styles.recordKind}>{kindLabels[record.kind]}</Text>
                <Text numberOfLines={3} style={styles.recordSummary}>{record.content}</Text>
              </View>
              {record.pinned ? (
                <View style={styles.pinnedBadge}>
                  <Text style={styles.pinnedText}>{tr('Pinned')}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.recordMeta}>
              <Text style={styles.scopeBadge}>{tr('Local only')}</Text>
              <Text numberOfLines={1} style={styles.sourceText}>{sourceSummary(record)}</Text>
            </View>
            <Text style={styles.updatedText}>Updated {formatDate(record.updatedAt)}</Text>
          </Card>
        </Pressable>
      ))}

      {hasMore ? (
        <Button
          title={paging ? 'Loading…' : tr('Load more')}
          variant="subtle"
          testID="memory-more"
          disabled={paging || loading}
          onPress={async () => {
            if (pagePending.current || loading) {return;}
            pagePending.current = true;
            setPaging(true);
            const request = version.current;
            try {
              const list = await services.memory.search({query, kind, limit: 30, offset: records.length});
              if (request !== version.current) {return;}
              setRecords(current => {
                const ids = new Set(current.map(item => item.id));
                return [...current, ...list.filter(item => !ids.has(item.id))];
              });
              setHasMore(list.length === 30);
            } catch (nextError) {
              if (request === version.current) {setError(safeError(nextError));}
            } finally {
              pagePending.current = false;
              setPaging(false);
            }
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function sourceSummary(record: MemoryRecord): string {
  if (record.source.kind === 'manual') {return tr('Saved manually');}
  if (record.source.kind === 'task') {return `Task · ${record.source.taskId}`;}
  return `Chat · ${record.source.sessionId}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? tr('Recently')
    : date.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
}

const styles = StyleSheet.create({
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  intro: {gap: space.sm, paddingBottom: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  libraryHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md},
  libraryCopy: {flex: 1, gap: 3},
  libraryTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  filterHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm},
  filterTitle: {fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.text},
  filters: {gap: space.sm, paddingVertical: space.xs},
  recordPressable: {borderRadius: radii.lg},
  pressed: {opacity: 0.84},
  recordCard: {gap: space.md},
  recordHeading: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm},
  recordHeadingCopy: {flex: 1, gap: space.xs},
  recordKind: {fontSize: 11, lineHeight: 15, fontWeight: '700', letterSpacing: 0.3, color: colors.accent},
  recordSummary: {fontSize: 15, lineHeight: 22, fontWeight: '600', color: colors.text},
  pinnedBadge: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: radii.pill, backgroundColor: colors.accentSoft},
  pinnedText: {fontSize: 10, lineHeight: 14, fontWeight: '700', color: colors.accent},
  recordMeta: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  scopeBadge: {fontSize: 11, lineHeight: 15, fontWeight: '600', color: colors.textMuted},
  sourceText: {flex: 1, fontSize: 11, lineHeight: 15, color: colors.textMuted},
  updatedText: {fontSize: 11, lineHeight: 15, color: colors.textMuted},
});
