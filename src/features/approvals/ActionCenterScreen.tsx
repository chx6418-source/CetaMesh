import {tr} from '../../shared/i18n';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {Approval, NeedsAttention} from '../../domain/task';
import type {MobileServices} from '../../runtime/session/MobileServices';
import type {ActionCenterItem} from '../../runtime/event/ActionCenterRuntime';
import {ErrorNotice, safeError, ui} from '../../shared/ui/Controls';
import {Button, Card, Chip, EmptyState, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';

type ActionFilter = 'all' | 'approval' | 'question' | 'blocked' | 'security' | 'completed';

const filters: {id: ActionFilter; label: string}[] = [
  {id: 'all', label: 'All'},
  {id: 'approval', label: tr('Approvals')},
  {id: 'question', label: tr('Questions')},
  {id: 'blocked', label: tr('Blocked')},
  {id: 'security', label: tr('Security')},
  {id: 'completed', label: 'Completed'},
];

export function ActionCenterScreen({
  services,
  onBack,
  onOpenTask,
}: {
  services: MobileServices;
  onBack: () => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const [actions, setActions] = useState<ActionCenterItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [attention, setAttention] = useState<NeedsAttention[]>([]);
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof safeError>>();
  const requestVersion = useRef(0);

  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(undefined);
    try {
      const [nextActions, nextApprovals, nextAttention] = await Promise.all([
        services.actionCenter.list(),
        services.approvals.listPending(),
        services.tasks.listNeedsAttention(),
      ]);
      if (version === requestVersion.current) {
        setActions(nextActions);
        setApprovals(nextApprovals);
        setAttention(nextAttention);
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

  const unifiedActions = useMemo(
    () => joinApprovalAttention(actions, approvals, attention),
    [actions, approvals, attention],
  );
  const visibleActions = unifiedActions.filter(item => filter === 'all' || item.kind === filter);
  const pendingCount = unifiedActions.filter(item => item.kind !== 'completed').length;

  const decide = async (approvalId: string, decision: 'approve-once' | 'deny') => {
    setActingId(approvalId);
    setError(undefined);
    try {
      await services.approvals.decide(approvalId, decision);
      await reload();
    } catch (nextError) {
      setError(safeError(nextError));
    } finally {
      setActingId(undefined);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.topRow}>
        <Button title={tr('Tasks')} variant="subtle" testID="back-action-center" onPress={onBack} />
        <Button title={tr('Refresh')} variant="subtle" testID="action-center-refresh" disabled={loading} onPress={reload} />
      </View>
      <View style={styles.intro}>
        <Text style={styles.eyebrow}>{tr('DECISIONS AND FOLLOW-UPS')}</Text>
        <Text style={ui.title}>{tr('Action Center')}</Text>
        <Text style={ui.text}>
          Review requests that need your decision, then return to the task.
        </Text>
      </View>

      <Card style={styles.summaryCard}>
        <Text style={styles.summaryValue}>{loading || error ? '—' : pendingCount}</Text>
        <View style={styles.summaryCopy}>
          <Text style={styles.summaryTitle}>
            {loading
              ? tr('Checking pending actions…')
              : error
                ? tr('Action status unavailable')
                : pendingCount
                  ? tr('Items need your attention')
                  : tr('You’re all caught up')}
          </Text>
          <Text style={ui.label}>{tr('Approvals, questions, blocked work, and security events')}</Text>
        </View>
      </Card>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {filters.map(item => (
          <Chip
            key={item.id}
            label={`${item.label} · ${unifiedActions.filter(action => action.kind === item.id || item.id === 'all').length}`}
            selected={filter === item.id}
            testID={`action-filter-${item.id}`}
            onPress={() => setFilter(item.id)}
          />
        ))}
      </ScrollView>

      <ErrorNotice error={error} />
      {loading ? (
        <LoadingState label={tr('Loading pending actions…')} />
      ) : null}
      {!loading && !error && !visibleActions.length ? (
        <EmptyState
          testID="action-center-empty"
          icon="✓"
          title={filter === 'all' ? tr('You’re all caught up') : `No ${filter} items`}
          description={tr('New approvals and task questions will appear here.')}
        />
      ) : null}

      {visibleActions.map(item => {
        const approval = approvals.find(candidate => item.actionId === `approval:${candidate.approvalId}`);
        const busy = approval ? actingId === approval.approvalId : false;
        return (
          <Card key={item.actionId} testID={`action-${item.actionId}`} style={styles.actionCard}>
            <View style={styles.actionHeading}>
              <View style={[styles.kindMark, kindTone(item.kind)]}>
                <Text style={[styles.kindMarkText, kindTextTone(item.kind)]}>{kindMark(item.kind)}</Text>
              </View>
              <View style={styles.actionTitleBlock}>
                <Text style={styles.actionKind}>{kindLabel(item.kind)}</Text>
                <Text style={styles.actionTitle}>{item.title}</Text>
              </View>
            </View>
            {item.summary ? <Text style={ui.text}>{item.summary}</Text> : null}
            {approval ? (
              <View style={styles.approvalDetails}>
                <View style={styles.approvalMeta}>
                  <Text style={styles.approvalMetaLabel}>{tr('Risk')}</Text>
                  <Text style={styles.approvalMetaValue}>{approval.risk}</Text>
                </View>
                <View style={styles.approvalMeta}>
                  <Text style={styles.approvalMetaLabel}>{tr('Scope')}</Text>
                  <Text style={styles.approvalMetaValue}>{formatScope(approval)}</Text>
                </View>
                <Text style={styles.expiryLabel}>Expires {formatDate(approval.expiresAt)}</Text>
              </View>
            ) : null}
            {approval ? (
              <View style={styles.actionButtons}>
                <Button
                  title={busy ? tr('Saving…') : tr('Approve once')}
                  variant="primary"
                  testID={`approve-${approval.approvalId}`}
                  disabled={Boolean(actingId)}
                  onPress={() => decide(approval.approvalId, 'approve-once')}
                />
                <Button
                  title={tr('Reject')}
                  variant="danger"
                  testID={`reject-${approval.approvalId}`}
                  disabled={Boolean(actingId)}
                  onPress={() => decide(approval.approvalId, 'deny')}
                />
              </View>
            ) : item.taskId && onOpenTask ? (
              <Button
                title={item.kind === 'completed' ? tr('View task') : tr('Open task')}
                variant="subtle"
                testID={`open-task-${item.taskId}`}
                onPress={() => onOpenTask(item.taskId!)}
              />
            ) : null}
          </Card>
        );
      })}
    </ScrollView>
  );
}

function joinApprovalAttention(
  actions: ActionCenterItem[],
  approvals: Approval[],
  attention: NeedsAttention[],
): ActionCenterItem[] {
  const relatedAttention = attention.filter(item => item.kind === 'approval.required');
  const matchedAttentionIds = new Set<string>();
  const joined = actions
    .filter(item => {
      const duplicateApprovalAttention = item.actionId.startsWith('attention:') &&
        item.kind === 'approval' && approvals.some(approval => approval.taskId === item.taskId);
      if (duplicateApprovalAttention) {
        const match = relatedAttention.find(attentionItem => attentionItem.taskId === item.taskId);
        if (match) {matchedAttentionIds.add(match.attentionId);}
      }
      return !duplicateApprovalAttention;
    })
    .map(item => {
      if (!item.actionId.startsWith('approval:')) {return item;}
      const approval = approvals.find(candidate => item.actionId === `approval:${candidate.approvalId}`);
      const related = approval
        ? relatedAttention.find(attentionItem => attentionItem.taskId === approval.taskId)
        : undefined;
      if (!approval || !related) {return item;}
      matchedAttentionIds.add(related.attentionId);
      return {
        ...item,
        title: related.title,
        summary: [related.summary, approval.reason].filter(Boolean).join(' · '),
      };
    });
  return joined.filter(item => {
    if (!item.actionId.startsWith('attention:') || item.kind !== 'approval') {return true;}
    const id = item.actionId.slice('attention:'.length);
    return !matchedAttentionIds.has(id);
  });
}

function kindLabel(kind: ActionCenterItem['kind']) {
  const labels: Record<ActionCenterItem['kind'], string> = {
    approval: tr('Approval request'),
    question: tr('Question'),
    blocked: tr('Blocked task'),
    completed: tr('Completed task'),
    security: tr('Security event'),
  };
  return labels[kind];
}

function kindMark(kind: ActionCenterItem['kind']) {
  if (kind === 'approval') {return '!';}
  if (kind === 'question') {return '?';}
  if (kind === 'blocked') {return 'Ⅱ';}
  if (kind === 'completed') {return '✓';}
  return '•';
}

function kindTone(kind: ActionCenterItem['kind']) {
  if (kind === 'completed') {return styles.completedMark;}
  if (kind === 'approval' || kind === 'blocked' || kind === 'security') {return styles.attentionMark;}
  return styles.questionMark;
}

function kindTextTone(kind: ActionCenterItem['kind']) {
  if (kind === 'completed') {return styles.completedMarkText;}
  if (kind === 'approval' || kind === 'blocked' || kind === 'security') {return styles.attentionMarkText;}
  return styles.questionMarkText;
}

function formatScope(approval: Approval) {
  return approval.scope.kind === 'task' ? tr('This task') : approval.scope.kind.replace(/[-_]+/g, ' ');
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'soon' : date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
}

const styles = StyleSheet.create({
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  topRow: {flexDirection: 'row', justifyContent: 'space-between', gap: space.sm},
  intro: {gap: space.sm, paddingVertical: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  summaryCard: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  summaryValue: {fontSize: 28, lineHeight: 34, fontWeight: '700', color: colors.accent},
  summaryCopy: {flex: 1, gap: 2},
  summaryTitle: {fontSize: 14, lineHeight: 19, fontWeight: '700', color: colors.text},
  filters: {gap: space.sm, paddingVertical: space.xs},
  actionCard: {gap: space.md},
  actionHeading: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  kindMark: {width: 34, height: 34, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center'},
  kindMarkText: {fontSize: 16, lineHeight: 20, fontWeight: '700'},
  attentionMark: {backgroundColor: colors.dangerSoft},
  attentionMarkText: {color: colors.danger},
  questionMark: {backgroundColor: colors.accentSoft},
  questionMarkText: {color: colors.accent},
  completedMark: {backgroundColor: colors.successSoft},
  completedMarkText: {color: colors.success},
  actionTitleBlock: {flex: 1, gap: 2},
  actionKind: {fontSize: 11, lineHeight: 15, fontWeight: '700', letterSpacing: 0.3, color: colors.textMuted},
  actionTitle: {fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.text},
  approvalDetails: {padding: space.md, borderRadius: radii.md, backgroundColor: colors.background, gap: space.sm},
  approvalMeta: {flexDirection: 'row', justifyContent: 'space-between', gap: space.md},
  approvalMetaLabel: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  approvalMetaValue: {fontSize: 12, lineHeight: 17, fontWeight: '700', color: colors.text},
  expiryLabel: {fontSize: 11, lineHeight: 15, color: colors.textMuted},
  actionButtons: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
});
