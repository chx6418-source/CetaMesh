import {tr} from '../../shared/i18n';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {Task, TaskStatus} from '../../domain/task';
import type {MobileServices} from '../../runtime/session/MobileServices';
import type {ActionCenterItem} from '../../runtime/event/ActionCenterRuntime';
import {ErrorNotice, safeError, ui} from '../../shared/ui/Controls';
import {Button, Card, Chip, EmptyState, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';
import {ActionCenterScreen} from '../approvals/ActionCenterScreen';
import {TaskScreen} from './TaskScreen';
import {clampProgress, matchesFilter, statusLabel, type TaskFilter} from './taskPresentation';

const taskFilters: {id: TaskFilter; label: string}[] = [
  {id: 'all', label: 'All'},
  {id: 'active', label: 'In progress'},
  {id: 'attention', label: 'Needs attention'},
  {id: 'completed', label: 'Completed'},
];

export function TasksScreen({services}: {services: MobileServices}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [actions, setActions] = useState<ActionCenterItem[]>([]);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [taskId, setTaskId] = useState<string>();
  const [actionCenterOpen, setActionCenterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof safeError>>();
  const requestVersion = useRef(0);

  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(undefined);
    try {
      const [nextTasks, nextActions] = await Promise.all([
        services.tasks.list(),
        services.actionCenter.list(),
      ]);
      if (version === requestVersion.current) {
        setTasks(nextTasks);
        setActions(nextActions);
      }
    } catch (nextError) {
      if (version === requestVersion.current) {
        setError(safeError(nextError));
      }
    } finally {
      if (version === requestVersion.current) {
        setLoading(false);
      }
    }
  }, [services]);

  useEffect(() => {
    const version = requestVersion;
    reload();
    return () => {
      version.current++;
    };
  }, [reload]);

  if (actionCenterOpen) {
    return (
      <ActionCenterScreen
        services={services}
        onBack={() => {
          setActionCenterOpen(false);
          reload();
        }}
        onOpenTask={nextTaskId => {
          setActionCenterOpen(false);
          setTaskId(nextTaskId);
        }}
      />
    );
  }

  if (taskId) {
    return (
      <TaskScreen
        services={services}
        taskId={taskId}
        onBack={() => {
          setTaskId(undefined);
          reload();
        }}
        onOpenActionCenter={() => {
          setTaskId(undefined);
          setActionCenterOpen(true);
        }}
      />
    );
  }

  const activeCount = tasks.filter(task => ['queued', 'running'].includes(task.status)).length;
  const attentionCount = tasks.filter(task => ['blocked', 'paused', 'failed'].includes(task.status)).length;
  const completedCount = tasks.filter(task => task.status === 'completed').length;
  const pendingActionCount = actions.filter(item => item.kind !== 'completed').length;
  const filtered = tasks
    .filter(task => matchesFilter(task.status, filter))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {loading || error ? (
        <Text style={ui.label}>{loading ? tr('Loading task totals…') : tr('Task totals unavailable')}</Text>
      ) : (
        <View style={styles.summaryRow}>
          <SummaryCard label={tr('In progress')} value={activeCount} />
          <SummaryCard label={tr('Needs you')} value={attentionCount} tone="attention" />
          <SummaryCard label={tr('Completed')} value={completedCount} tone="completed" />
        </View>
      )}

      <Card style={styles.actionCard}>
        <View style={styles.actionCopy}>
          <Text style={styles.sectionTitle}>{tr('Action Center')}</Text>
          <Text style={ui.label}>
            {pendingActionCount
              ? `${pendingActionCount} item${pendingActionCount === 1 ? '' : 's'} need review`
              : tr('Approvals, questions, and blocked work')}
          </Text>
        </View>
        <Button
          title={tr('Review')}
          variant="primary"
          testID="tasks-action-center"
          onPress={() => setActionCenterOpen(true)}
        />
      </Card>

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{tr('Your tasks')}</Text>
        <Button
          title={tr('Refresh')}
          variant="subtle"
          testID="tasks-refresh"
          disabled={loading}
          onPress={reload}
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {taskFilters.map(item => (
          <Chip
            key={item.id}
            label={`${item.label} · ${tasks.filter(task => matchesFilter(task.status, item.id)).length}`}
            selected={filter === item.id}
            testID={`tasks-filter-${item.id}`}
            onPress={() => setFilter(item.id)}
          />
        ))}
      </ScrollView>

      <ErrorNotice error={error} />
      {loading ? (
        <LoadingState label={tr('Loading tasks…')} testID="tasks-loading" />
      ) : null}
      {!loading && !error && !filtered.length ? (
        <EmptyState
          testID="tasks-empty-state"
          icon="✓"
          title={tasks.length ? tr('No tasks in this view') : tr('No tasks yet')}
          description={tasks.length
            ? tr('Choose another filter to see more work.')
            : tr('Tasks you create or receive will collect here.')}
        >
          {filter !== 'all' ? (
            <Button title={tr('Show all tasks')} onPress={() => setFilter('all')} />
          ) : null}
        </EmptyState>
      ) : null}

      {filtered.map(task => (
        <Pressable
          key={task.taskId}
          accessibilityRole="button"
          accessibilityLabel={`${task.goal}, ${statusLabel(task.status)}, ${Math.round(task.progress * 100)} percent`}
          onPress={() => setTaskId(task.taskId)}
          testID={`task-${task.taskId}`}
          style={({pressed}) => [styles.taskPressable, pressed && styles.pressed]}>
          <Card style={styles.taskCard}>
            <View style={styles.taskHeading}>
              <Text numberOfLines={2} style={styles.taskTitle}>{task.goal}</Text>
              <StatusChip status={task.status} />
            </View>
            <Text style={styles.taskPhase}>{formatPhase(task.phase)}  ·  {task.source}</Text>
            <View
              accessibilityRole="progressbar"
              accessibilityLabel={tr('Task progress')}
              accessibilityValue={{min: 0, max: 100, now: Math.round(clampProgress(task.progress))}}
              style={styles.progressTrack}>
              <View style={[styles.progressFill, {width: `${clampProgress(task.progress)}%`}]} />
            </View>
            <View style={styles.taskFooter}>
              <Text style={styles.progressLabel}>{Math.round(clampProgress(task.progress))}%</Text>
              <Text style={styles.updatedLabel}>{formatDate(task.updatedAt)}</Text>
            </View>
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: number;
  tone?: 'normal' | 'attention' | 'completed';
}) {
  return (
    <Card style={styles.summaryCard}>
      <Text style={[styles.summaryValue, tone === 'attention' && styles.attentionText, tone === 'completed' && styles.completedText]}>
        {value}
      </Text>
      <Text numberOfLines={1} style={styles.summaryLabel}>{label}</Text>
    </Card>
  );
}

function StatusChip({status}: {status: TaskStatus}) {
  return (
    <View style={[styles.statusChip, statusTone(status)]}>
      <Text style={[styles.statusText, statusTextTone(status)]}>{statusLabel(status)}</Text>
    </View>
  );
}

function statusTone(status: TaskStatus) {
  if (status === 'completed') {return styles.completedChip;}
  if (status === 'blocked' || status === 'failed') {return styles.attentionChip;}
  if (status === 'running') {return styles.activeChip;}
  return styles.neutralChip;
}

function statusTextTone(status: TaskStatus) {
  if (status === 'completed') {return styles.completedTextSmall;}
  if (status === 'blocked' || status === 'failed') {return styles.attentionTextSmall;}
  if (status === 'running') {return styles.activeTextSmall;}
  return styles.neutralTextSmall;
}

function formatPhase(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? tr('Recently updated') : `Updated ${date.toLocaleDateString()}`;
}

const styles = StyleSheet.create({
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  summaryRow: {flexDirection: 'row', gap: space.sm},
  summaryCard: {flex: 1, minWidth: 0, paddingHorizontal: space.md, paddingVertical: space.md, gap: 2},
  summaryValue: {fontSize: 20, lineHeight: 26, fontWeight: '700', color: colors.text},
  summaryLabel: {fontSize: 10, lineHeight: 14, color: colors.textMuted},
  attentionText: {color: colors.danger},
  completedText: {color: colors.success},
  actionCard: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md},
  actionCopy: {flex: 1, gap: 2},
  sectionHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, marginTop: space.sm},
  sectionTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  filters: {gap: space.sm, paddingVertical: space.xs},
  taskPressable: {borderRadius: radii.lg},
  pressed: {opacity: 0.82},
  taskCard: {gap: space.sm},
  taskHeading: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm},
  taskTitle: {flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '700', color: colors.text},
  taskPhase: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  progressTrack: {height: 6, overflow: 'hidden', borderRadius: radii.pill, backgroundColor: colors.surfaceMuted},
  progressFill: {height: 6, borderRadius: radii.pill, backgroundColor: colors.accent},
  taskFooter: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm},
  progressLabel: {fontSize: 11, lineHeight: 15, fontWeight: '700', color: colors.accent},
  updatedLabel: {fontSize: 11, lineHeight: 15, color: colors.textMuted},
  statusChip: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: radii.pill},
  statusText: {fontSize: 10, lineHeight: 14, fontWeight: '700'},
  completedChip: {backgroundColor: colors.successSoft},
  attentionChip: {backgroundColor: colors.dangerSoft},
  activeChip: {backgroundColor: colors.accentSoft},
  neutralChip: {backgroundColor: colors.surfaceMuted},
  completedTextSmall: {color: colors.success},
  attentionTextSmall: {color: colors.danger},
  activeTextSmall: {color: colors.accent},
  neutralTextSmall: {color: colors.textMuted},
});
