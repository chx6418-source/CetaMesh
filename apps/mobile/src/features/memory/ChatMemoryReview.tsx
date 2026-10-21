import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import type { MemoryCandidate } from '../../domain/memory/MemoryCandidate';
import type { ChatMemoryExtraction } from '../../runtime/memory/ChatMemoryExtraction';
import type { CetaError } from '../../shared/errors/CetaError';
import { Action, ErrorNotice, safeError, ui } from '../../shared/ui/Controls';
import { EmptyState, LoadingState } from '../../shared/ui/DesignSystem';
import { MemorySourceLabel } from './MemoryEditor';
export function ChatMemoryReview({
  sessionId,
  extraction,
  onBack,
}: {
  sessionId: string;
  extraction: ChatMemoryExtraction;
  onBack: () => void;
}) {
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<CetaError>();
  const ids = useRef<string[]>([]),
    pending = useRef(false);
  useEffect(() => {
    let mounted = true;
    extraction
      .preview(sessionId)
      .then(rows => {
        if (!mounted) {
          rows.forEach(r => extraction.reject(r.id));
          return;
        }
        ids.current = rows.map(r => r.id);
        setCandidates(rows);
      })
      .catch(e => {
        if (mounted) {
          setError(safeError(e));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
      ids.current.forEach(id => extraction.reject(id));
    };
  }, [extraction, sessionId]);
  const remove = (id: string) => {
    ids.current = ids.current.filter(i => i !== id);
    setCandidates(rows => rows.filter(r => r.id !== id));
  };
  return (
    <ScrollView
      contentContainerStyle={ui.page}
      keyboardShouldPersistTaps="handled"
    >
      <Action
        title="返回会话"
        testID="memory-review-back"
        disabled={busy}
        onPress={onBack}
      />
      <Text style={ui.title}>记忆候选</Text>
      <Text style={ui.text}>
        仅识别完成的用户文本中明确的“记住 / Remember”请求。确认后才保存，默认
        local-only。
      </Text>
      <Text selectable style={ui.label}>
        来源会话：{sessionId} · 最多检查最近 200 条消息，显示最近 10 条候选。
      </Text>
      <ErrorNotice error={error} />
      {loading ? <LoadingState label="生成本地候选…" /> : null}
      {!loading && !error && !candidates.length ? (
        <EmptyState
          title="没有待确认的候选"
          description="可返回 Memory 手动保存。"
        />
      ) : null}
      {candidates.map(c => (
        <View key={c.id} style={ui.card}>
          <MemorySourceLabel source={c.source} />
          <TextInput
            testID={'candidate-content-' + c.id}
            accessibilityLabel="候选内容"
            style={ui.input}
            multiline
            editable={!busy}
            value={c.content}
            onChangeText={content =>
              setCandidates(rows =>
                rows.map(r => (r.id === c.id ? { ...r, content } : r)),
              )
            }
          />
          <View style={ui.row}>
            <Action
              title="确认保存"
              testID={'candidate-confirm-' + c.id}
              disabled={busy}
              onPress={async () => {
                if (pending.current) {
                  return;
                }
                pending.current = true;
                setBusy(true);
                setError(undefined);
                try {
                  await extraction.confirm(c.id, c.content);
                  remove(c.id);
                } catch (e) {
                  setError(safeError(e));
                } finally {
                  pending.current = false;
                  setBusy(false);
                }
              }}
            />
            <Action
              title="拒绝"
              testID={'candidate-reject-' + c.id}
              disabled={busy}
              onPress={() => {
                extraction.reject(c.id);
                remove(c.id);
              }}
            />
          </View>
        </View>
      ))}
    </ScrollView>
  );
}
