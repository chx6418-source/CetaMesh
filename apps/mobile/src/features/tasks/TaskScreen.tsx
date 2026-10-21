import {tr} from '../../shared/i18n';
import React, {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {NeedsAttention, Task, TaskStatus} from '../../domain/task';
import type {MobileServices} from '../../runtime/session/MobileServices';
import {ErrorNotice, safeError, ui} from '../../shared/ui/Controls';
import {Button, Card, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';
import {clampProgress, statusLabel} from './taskPresentation';

export function TaskScreen({
  services,
  taskId,
  onBack,
  onOpenActionCenter,
}: {
  services: MobileServices;
  taskId: string;
  onBack: () => void;
  onOpenActionCenter?: () => void;
}) {
  const [task, setTask] = useState<Task>();
  const [attention, setAttention] = useState<NeedsAttention[]>([]);
  const [error, setError] = useState<ReturnType<typeof safeError>>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([services.tasks.get(taskId), services.tasks.listNeedsAttention(taskId)])
      .then(([nextTask, nextAttention]) => {
        if (mounted) {
          setTask(nextTask);
          setAttention(nextAttention);
          setError(undefined);
        }
      })
      .catch(nextError => {
        if (mounted) {
          setError(safeError(nextError));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [services, taskId]);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Button title={tr('All tasks')} testID="back-tasks" variant="subtle" onPress={onBack} />
      <View style={styles.titleBlock}>
        <Text style={styles.eyebrow}>{tr('TASK DETAILS')}</Text>
        <Text style={ui.title}>{tr('Task details')}</Text>
      </View>
      <ErrorNotice error={error} />
      {loading ? (
        <LoadingState label={tr('Loading task details…')} />
      ) : null}
      {!loading && task ? (
        <>
          <Card style={styles.overviewCard} testID="task-detail">
            <View style={styles.taskTitleRow}>
              <Text style={styles.goal}>{task.goal}</Text>
              <TaskStatusChip status={task.status} />
            </View>
            <View style={styles.progressHeading}>
              <Text style={styles.cardLabel}>{tr('Progress')}</Text>
              <Text style={styles.progressValue}>{clampProgress(task.progress)}%</Text>
            </View>
            <View
              accessibilityRole="progressbar"
              accessibilityLabel={tr('Task progress')}
              accessibilityValue={{min: 0, max: 100, now: clampProgress(task.progress)}}
              style={styles.progressTrack}>
              <View style={[styles.progressFill, {width: `${clampProgress(task.progress)}%`}]} />
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>{tr('Current phase')}</Text>
              <Text style={styles.infoValue}>{formatPhase(task.phase)}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>{tr('Source')}</Text>
              <Text style={styles.infoValue}>{formatSource(task.source)}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>{tr('Updated')}</Text>
              <Text style={styles.infoValue}>{formatDate(task.updatedAt)}</Text>
            </View>
          </Card>

          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>{tr('Execution context')}</Text>
          </View>
          {task.providerExecutionRef ? (
            <Card>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>{tr('Provider')}</Text>
                <Text selectable style={styles.infoValue}>{task.providerExecutionRef.providerId}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>{tr('Session')}</Text>
                <Text selectable style={styles.infoValue}>{task.providerExecutionRef.sessionId ?? tr('Not linked')}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>{tr('Context')}</Text>
                <Text style={styles.infoValue}>{formatContext(task.providerExecutionRef.contextUsage)}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>{tr('Execution state')}</Text>
                <Text style={styles.infoValue}>{task.providerExecutionRef.state}</Text>
              </View>
            </Card>
          ) : (
            <Card>
              <Text style={ui.text}>{tr('This task is not linked to an execution session.')}</Text>
            </Card>
          )}

          <View style={styles.sectionHeading}>
            <View>
              <Text style={styles.sectionTitle}>{tr('Needs attention')}</Text>
              <Text style={ui.label}>{attention.length} open item{attention.length === 1 ? '' : 's'}</Text>
            </View>
            {attention.length && onOpenActionCenter ? (
              <Button title={tr('Review')} variant="subtle" testID="task-open-action-center" onPress={onOpenActionCenter} />
            ) : null}
          </View>
          {attention.length ? (
            attention.map(item => (
              <Card key={item.attentionId}>
                <Text style={styles.attentionTitle}>{item.title}</Text>
                {item.summary ? <Text style={ui.label}>{item.summary}</Text> : null}
                <Text style={styles.attentionKind}>{attentionLabel(item.kind)}</Text>
              </Card>
            ))
          ) : (
            <Card>
              <Text style={ui.label}>{tr('There are no open questions or approvals for this task.')}</Text>
            </Card>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

function TaskStatusChip({status}: {status: TaskStatus}) {
  const tone = status === 'completed'
    ? styles.completedStatus
    : status === 'failed' || status === 'blocked'
      ? styles.attentionStatus
      : status === 'running'
        ? styles.runningStatus
        : styles.neutralStatus;
  const textTone = status === 'completed'
    ? styles.completedStatusText
    : status === 'failed' || status === 'blocked'
      ? styles.attentionStatusText
      : status === 'running'
        ? styles.runningStatusText
        : styles.neutralStatusText;
  return (
    <View style={[styles.statusChip, tone]}>
      <Text style={[styles.statusText, textTone]}>{statusLabel(status)}</Text>
    </View>
  );
}

function formatPhase(value: string) {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatSource(value: string) {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? tr('Unknown') : date.toLocaleString();
}

function formatContext(value?: {usedTokens?: number; limitTokens?: number}) {
  if (!value) {return tr('Not reported');}
  const used = value.usedTokens ?? 0;
  const limit = value.limitTokens;
  return limit === undefined ? `${used} tokens used` : `${used} / ${limit} tokens`;
}

function attentionLabel(kind: NeedsAttention['kind']) {
  if (kind === 'question.required') {return tr('Question');}
  if (kind === 'approval.required') {return tr('Approval');}
  if (kind === 'task.blocked') {return tr('Blocked');}
  return 'Needs attention';
}

const styles = StyleSheet.create({
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  titleBlock: {gap: space.xs, paddingVertical: space.sm},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  overviewCard: {gap: space.md},
  taskTitleRow: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm},
  goal: {flex: 1, fontSize: 18, lineHeight: 25, fontWeight: '700', color: colors.text},
  progressHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  cardLabel: {fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.textMuted},
  progressValue: {fontSize: 13, lineHeight: 18, fontWeight: '700', color: colors.accent},
  progressTrack: {height: 8, overflow: 'hidden', borderRadius: radii.pill, backgroundColor: colors.surfaceMuted},
  progressFill: {height: 8, borderRadius: radii.pill, backgroundColor: colors.accent},
  infoRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md},
  infoLabel: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  infoValue: {flexShrink: 1, textAlign: 'right', fontSize: 12, lineHeight: 17, fontWeight: '600', color: colors.text},
  sectionHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, marginTop: space.md},
  sectionTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  statusChip: {paddingHorizontal: 10, paddingVertical: 5, borderRadius: radii.pill},
  statusText: {fontSize: 10, lineHeight: 14, fontWeight: '700'},
  completedStatus: {backgroundColor: colors.successSoft},
  attentionStatus: {backgroundColor: colors.dangerSoft},
  runningStatus: {backgroundColor: colors.accentSoft},
  neutralStatus: {backgroundColor: colors.surfaceMuted},
  completedStatusText: {color: colors.success},
  attentionStatusText: {color: colors.danger},
  runningStatusText: {color: colors.accent},
  neutralStatusText: {color: colors.textMuted},
  attentionTitle: {fontSize: 14, lineHeight: 20, fontWeight: '600', color: colors.text},
  attentionKind: {fontSize: 11, lineHeight: 15, color: colors.accent},
});
