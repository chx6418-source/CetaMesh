import {tr} from '../../shared/i18n';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type {MobileServices} from '../../runtime/session/MobileServices';
import type {
  Attachment,
  ChatMessage,
  ChatSession,
  ChatSessionConfig,
} from '../../domain/chat/ChatRepository';
import {
  parseAttachmentCapabilityResult,
  type AttachmentCapability,
} from '../../domain/capability/Attachment';
import type {ProviderConfig} from '../../domain/model/ModelProvider';
import type {CetaError} from '../../shared/errors/CetaError';
import {Action, ErrorNotice, Field, safeError, ui} from '../../shared/ui/Controls';
import {BottomSheet, Button, Card, Chip, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';
import {SessionOptions} from './SessionOptions';
import {ChatMemoryReview} from '../memory/ChatMemoryReview';
import Clipboard from '@react-native-clipboard/clipboard';
import {AssistantMarkdown, splitProcessPreamble} from './AssistantMarkdown';
import {cacheHitRate, type SessionUsage, type TokenUsage} from '../../domain/model/TokenUsage';
import {userErrorMessage} from '../../shared/errors/userMessage';

export function ChatScreen({
  id,
  services,
  providers,
  initialDraft,
  onDraftChange,
  onMemoryDraftSent,
  onBack,
}: {
  id: string;
  services: MobileServices;
  providers: ProviderConfig[];
  initialDraft?: string;
  onDraftChange?: (draft: string) => void;
  onMemoryDraftSent?: () => void;
  onBack: () => void;
}) {
  const [session, setSession] = useState<ChatSession>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [usage, setUsage] = useState<SessionUsage>();
  const [latestUsage, setLatestUsage] = useState<TokenUsage>();
  const [usageOpen, setUsageOpen] = useState(false);
  const [config, setConfig] = useState<ChatSessionConfig>();
  const [title, setTitle] = useState('');
  const [input, setInput] = useState(initialDraft ?? '');
  const [memoryDraftActive, setMemoryDraftActive] = useState(Boolean(initialDraft));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(services.chat.isRunning(id));
  const [error, setError] = useState<CetaError>();
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [attachmentSheetOpen, setAttachmentSheetOpen] = useState(false);
  const [memoryReview, setMemoryReview] = useState(false);
  const [older, setOlder] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const pagePending = useRef(false);
  const messageVersion = useRef(0);
  const listRef = useRef<React.ElementRef<typeof ScrollView>>(null);
  const userIsNearBottom = useRef(true);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      if (userIsNearBottom.current) {
        requestAnimationFrame(() => listRef.current?.scrollToEnd({animated: false}));
      }
    });
    return () => show.remove();
  }, []);

  const capabilities = services.capabilityRuntime.listCapabilities?.() ?? [];
  const canPickPhotos = capabilities.some(item => item.name === 'photos.select');
  const canPickFiles = capabilities.some(item => item.name === 'file.pick');
  const canPickAttachments = canPickPhotos || canPickFiles;

  const reload = useCallback(async () => {
    const version = ++messageVersion.current;
    const [nextSession, rows, nextUsage] = await Promise.all([
      services.sessions.get(id),
      services.chat.messages(id),
      services.chat.usage(id),
    ]);
    if (version !== messageVersion.current) {
      return;
    }
    setSession(nextSession);
    setConfig(nextSession.config);
    setTitle(nextSession.title);
    setMessages(rows);
    setUsage(nextUsage);
    const lastAssistant = [...rows].reverse().find(message => message.role === 'assistant');
    setLatestUsage(lastAssistant ? await services.chat.turnUsage(lastAssistant.id) : undefined);
    setOlder(rows.length === 40);
    setBusy(services.chat.isRunning(id));
  }, [id, services]);

  useEffect(() => {
    const version = messageVersion;
    let mounted = true;
    reload().catch(nextError => {
      if (mounted) {
        setError(safeError(nextError));
      }
    });
    const off = services.chat.subscribe(event => {
      if (event.sessionId !== id || !mounted) {
        return;
      }
      if (event.type === 'delta') {
        setMessages(rows =>
          rows.map(message =>
            message.id === event.messageId
              ? {...message, content: event.text ?? '', status: 'streaming'}
              : message,
          ),
        );
      } else {
        if (event.type === 'started') {
          setLatestUsage(undefined);
          if (event.operation === 'send') {
            setInput('');
            setAttachments([]);
          }
          setBusy(true);
        }
        const request = ++messageVersion.current;
        Promise.all([services.chat.messages(id), services.chat.usage(id)])
          .then(([rows, nextUsage]) => {
            if (mounted && request === messageVersion.current) {
              setMessages(rows);
              setUsage(nextUsage);
              const lastAssistant = [...rows].reverse().find(message => message.role === 'assistant');
              if (lastAssistant) {
                services.chat.turnUsage(lastAssistant.id).then(setLatestUsage).catch(() => setLatestUsage(undefined));
              }
              setBusy(services.chat.isRunning(id));
            }
          })
          .catch(nextError => {
            if (mounted) {
              setError(safeError(nextError));
            }
          });
      }
    });
    return () => {
      mounted = false;
      version.current++;
      off();
    };
  }, [id, services, reload]);

  const perform = async (fn: () => Promise<void>) => {
    setError(undefined);
    try {
      await fn();
      await reload();
    } catch (nextError) {
      setError(safeError(nextError));
    }
  };

  const send = async () => {
    if (!config || !session || session.archived) {
      return;
    }
    const draft = input;
    setBusy(true);
    setError(undefined);
    try {
      await services.chat.send(id, draft, attachments);
      setInput('');
      setAttachments([]);
      if (memoryDraftActive) {
        onMemoryDraftSent?.();
        setMemoryDraftActive(false);
      }
    } catch (nextError) {
      setError(safeError(nextError));
    } finally {
      setBusy(false);
      await reload().catch(nextError => setError(safeError(nextError)));
    }
  };

  const pickAttachment = async (name: AttachmentCapability) => {
    setAttachmentSheetOpen(false);
    setPicking(true);
    setError(undefined);
    try {
      const result = await services.capabilityRuntime.invoke({name});
      const file = parseAttachmentCapabilityResult(name, result);
      setAttachments(current => [...current, file]);
    } catch (nextError) {
      const failure = safeError(nextError);
      if (failure.code !== 'cancelled') {
        setError(failure);
      }
    } finally {
      setPicking(false);
    }
  };

  if (memoryReview) {
    return (
      <ChatMemoryReview
        sessionId={id}
        extraction={services.memoryExtraction}
        onBack={() => setMemoryReview(false)}
      />
    );
  }

  if (!session || !config) {
    return (
      <View style={styles.loadingState}>
        <Action title={tr('Back to chats')} onPress={onBack} />
        <Text style={ui.title}>{tr('Opening conversation')}</Text>
        {error ? <ErrorNotice error={error} /> : <LoadingState label={tr('Loading messages…')} />}
      </View>
    );
  }

  const latestMessage = messages[messages.length - 1];
  const settingsDirty =
    config.mode !== session.config.mode ||
    config.modelProviderId !== session.config.modelProviderId ||
    config.modelId !== session.config.modelId ||
    config.reasoning !== session.config.reasoning;
  const composerDisabled = busy || picking || session.archived || settingsDirty;
  const currentUsageState = busy ? 'pending' : latestUsage ? 'reported' : 'unsupported';
  const currentUsageValue = (value: number | undefined) => currentUsageState === 'pending' ? '统计中…' : value === undefined ? '—' : formatTokens(value);
  const currentCacheRate = currentUsageState === 'pending' ? '统计中…' : cacheHitRate(latestUsage) === null ? '—' : `${cacheHitRate(latestUsage)!.toFixed(1)}%`;

  const onMessageScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
    userIsNearBottom.current =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < 96;
  };

  return (
    <KeyboardAvoidingView
      testID="chat-keyboard-container"
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}>
      <View style={styles.conversationHeader}>
        <Button
          title={tr('Sessions')}
          variant="subtle"
          testID="chat-sessions"
          onPress={onBack}
        />
        <View style={styles.conversationHeading}>
          <Text numberOfLines={1} style={styles.conversationTitle}>
            {session.title}
          </Text>
          <Text style={styles.conversationMeta}>
            {session.archived ? tr('Archived') : tr('Conversation')}
          </Text>
        </View>
        <Button
          title="•••"
          variant="subtle"
          testID="chat-session-menu-open"
          onPress={() => setSessionMenuOpen(true)}
        />
      </View>

      {settingsDirty ? (
        <View style={styles.unsavedNotice}>
          <Text style={styles.unsavedText}>{tr('Save these options before sending with them.')}</Text>
        </View>
      ) : null}
      <ErrorNotice error={error} friendly />

      <ScrollView
        ref={listRef}
        testID="chat-message-list"
        style={styles.messageList}
        contentContainerStyle={[
          styles.messageListContent,
          messages.length === 0 && styles.messageListEmpty,
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        scrollEventThrottle={16}
        onLayout={() => {
          if (userIsNearBottom.current) {listRef.current?.scrollToEnd({animated: false});}
        }}
        onScroll={onMessageScroll}
        onContentSizeChange={() => {
          if (userIsNearBottom.current) {
            listRef.current?.scrollToEnd({animated: false});
          }
        }}>
        {older ? (
          <Action
            title={tr(loadingPage ? 'Loading earlier messages…' : 'Load earlier messages')}
            testID="load-earlier-messages"
            disabled={loadingPage}
            onPress={async () => {
              if (pagePending.current || !messages.length) {
                return;
              }
              pagePending.current = true;
              setLoadingPage(true);
              const version = messageVersion.current;
              userIsNearBottom.current = false;
              try {
                const page = await services.chat.messages(id, {
                  before: messages[0].sequence,
                });
                if (version !== messageVersion.current) {
                  return;
                }
                setMessages(current => {
                  const ids = new Set(current.map(message => message.id));
                  return [
                    ...page.filter(message => !ids.has(message.id)),
                    ...current,
                  ];
                });
                setOlder(page.length === 40);
              } catch (nextError) {
                if (version === messageVersion.current) {
                  setError(safeError(nextError));
                }
              } finally {
                pagePending.current = false;
                setLoadingPage(false);
              }
            }}
          />
        ) : null}

        {messages.length === 0 ? (
          <View style={styles.emptyConversation}>
            <View style={styles.emptyMark}>
              <Text style={styles.emptyMarkText}>C</Text>
            </View>
            <Text style={styles.emptyTitle}>{tr('Start with a question')}</Text>
            <Text style={styles.emptyCopy}>{tr('Your conversation will stay in this session.')}</Text>
          </View>
        ) : null}

        {messages.map(message => (
          <MessageBubble
            key={message.id}
            message={message}
            isLatest={message.id === latestMessage?.id}
            retryDisabled={busy || session.archived || settingsDirty}
            onRetry={() => {
              setBusy(true);
              return perform(() => services.chat.retry(id)).finally(() =>
                setBusy(false),
              );
            }}
            onContinue={() => {
              setBusy(true);
              return perform(() => services.chat.continueReply(id)).finally(() => setBusy(false));
            }}
          />
        ))}
      </ScrollView>

      <View testID="chat-composer" style={styles.composer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.composerStatusRow} testID="composer-status-row">
          <SessionOptions
            value={config}
            onChange={setConfig}
            services={services}
            providers={providers}
            disabled={busy || session.archived}
            onSave={() => perform(() => services.sessions.configure(id, config))}
          />
          <Button
            title={usage ? `${formatTokens(usage.totalTokens)} Token · 缓存 ${cacheHitRate(usage) === null ? '—' : `${cacheHitRate(usage)!.toFixed(1)}%`}` : '会话用量 · —'}
            variant="subtle" testID="session-usage-open" onPress={() => setUsageOpen(true)}
            style={styles.usageButton}
          />
        </ScrollView>
        {attachments.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.attachmentRow}>
            {attachments.map(file => (
              <Chip
                key={file.id}
                label={`${file.name} · ${Math.round(file.size / 1024)} KB ×`}
                testID={`remove-attachment-${file.id}`}
                disabled={busy || session.archived}
                onPress={() =>
                  setAttachments(current => current.filter(item => item.id !== file.id))
                }
              />
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.composerRow}>
          <Button
            title="＋"
            variant="subtle"
            testID="attachments-open"
            disabled={busy || picking || session.archived || attachments.length >= 4}
            onPress={() => setAttachmentSheetOpen(true)}
          />
          <TextInput
            testID="message-input"
            accessibilityLabel={tr('Message')}
            accessibilityHint={tr('Write a message for this conversation')}
            style={styles.composerInput}
            multiline
            scrollEnabled
            textAlignVertical="top"
            editable={!composerDisabled}
            placeholder={session.archived ? tr('This session is archived') : tr('Enter a message…')}
            placeholderTextColor={colors.textMuted}
            value={input}
            onChangeText={value => {
              setInput(value);
              if (memoryDraftActive) {onDraftChange?.(value);}
            }}
          />
          {busy ? (
            <Button
              title={tr('Stop')}
              variant="danger"
              testID="stop"
              onPress={() => services.chat.cancel(id)}
            />
          ) : (
            <Button
              title={tr('Send')}
              variant="primary"
              testID="send"
              disabled={
                composerDisabled || (!input.trim() && attachments.length === 0)
              }
              onPress={send}
            />
          )}
        </View>
        {memoryDraftActive ? (
          <Text testID="chat-memory-draft-hint" style={styles.memoryDraftHint}>{tr('Review this saved memory before sending')}</Text>
        ) : null}
        {settingsDirty ? (
          <Text style={styles.composerHint}>{tr('Options changed · save to apply')}</Text>
        ) : null}
      </View>

      <BottomSheet
        visible={usageOpen}
        title="会话用量"
        onClose={() => setUsageOpen(false)}
        testIDPrefix="session-usage-sheet">
        <View style={styles.usageSheet}>
          <Text style={styles.sheetActionTitle}>当前轮</Text>
          <UsageRow label="输入" value={currentUsageValue(latestUsage?.inputTokens)} />
          <UsageRow label="输出" value={currentUsageValue(latestUsage?.outputTokens)} />
          <UsageRow label="缓存命中" value={currentUsageValue(latestUsage?.cachedInputTokens)} />
          <UsageRow label="缓存未命中" value={currentUsageValue(latestUsage?.cacheMissInputTokens)} />
          <UsageRow label="缓存命中率" value={currentCacheRate} />
          <Text style={styles.sheetActionTitle}>会话累计</Text>
          <UsageRow label="输入" value={usage ? formatTokens(usage.inputTokens) : '—'} />
          <UsageRow label="输出" value={usage ? formatTokens(usage.outputTokens) : '—'} />
          <UsageRow label="缓存命中" value={usage?.cachedInputTokens === undefined ? '—' : formatTokens(usage.cachedInputTokens)} />
          <UsageRow label="缓存未命中" value={usage?.cacheMissInputTokens === undefined ? '—' : formatTokens(usage.cacheMissInputTokens)} />
          <UsageRow label="总 Token" value={usage ? formatTokens(usage.totalTokens) : '—'} />
          <UsageRow label="缓存命中率" value={cacheHitRate(usage) === null ? '暂不支持或数据不完整' : `${cacheHitRate(usage)!.toFixed(1)}%`} />
          {usage?.partial ? <Text style={ui.label}>部分历史轮次缺少用量数据。</Text> : null}
        </View>
      </BottomSheet>

      <BottomSheet
        visible={attachmentSheetOpen}
        title={tr('Add to this message')}
        onClose={() => setAttachmentSheetOpen(false)}
        clearBackdrop
        hideCloseButton
        testIDPrefix="attachment-sheet">
        {canPickAttachments ? (
          <View style={styles.sheetActions}>
            {canPickPhotos ? (
              <Card>
                <Text style={styles.sheetActionTitle}>{tr('Photo or image')}</Text>
                <Text style={ui.label}>{tr('Add an image to your message.')}</Text>
                <Button
                  title={tr('Choose image')}
                  testID="pick-image"
                  disabled={picking || busy || session.archived || attachments.length >= 4}
                  onPress={() => pickAttachment('photos.select')}
                />
              </Card>
            ) : null}
            {canPickFiles ? (
              <Card>
                <Text style={styles.sheetActionTitle}>{tr('Text file')}</Text>
                <Text style={ui.label}>{tr('Attach a supported text document.')}</Text>
                <Button
                  title={tr('Choose file')}
                  testID="pick-file"
                  disabled={picking || busy || session.archived || attachments.length >= 4}
                  onPress={() => pickAttachment('file.pick')}
                />
              </Card>
            ) : null}
          </View>
        ) : (
          <Text style={styles.unavailableCopy}>{tr('Attachments are unavailable on this device.')}</Text>
        )}
      </BottomSheet>

      <BottomSheet
        visible={sessionMenuOpen}
        title={tr('Session actions')}
        onClose={() => setSessionMenuOpen(false)}
        testIDPrefix="session-menu-sheet">
        <View style={styles.sessionMenu}>
          <Text style={styles.sheetActionTitle}>{tr('Rename session')}</Text>
          <Field
            testID="session-title"
            label={tr('Session name')}
            value={title}
            onChangeText={setTitle}
          />
          <Button
            title={tr('Save name')}
            testID="session-rename"
            disabled={busy || session.archived || !title.trim()}
            onPress={() =>
              perform(async () => services.sessions.rename(id, title.trim()))
            }
          />
          <View style={styles.menuDivider} />
          <Button
            title={session.archived ? tr('Restore session') : tr('Archive session')}
            testID="session-archive"
            disabled={busy}
            onPress={() =>
              perform(() => services.sessions.archive(id, !session.archived))
            }
          />
          <Button
            title={tr('Delete session')}
            variant="danger"
            testID="session-delete"
            disabled={busy}
            onPress={() =>
              Alert.alert(tr('Delete this session?'), tr('Its messages will also be deleted.'), [
                {text: 'Cancel', style: 'cancel'},
                {
                  text: tr('Delete'),
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await services.sessions.delete(id);
                      setSessionMenuOpen(false);
                      onBack();
                    } catch (nextError) {
                      setError(safeError(nextError));
                    }
                  },
                },
              ])
            }
          />
          <Button
            title={tr('Review memory candidates')}
            variant="subtle"
            testID="review-memory"
            disabled={busy}
            onPress={() => {
              setSessionMenuOpen(false);
              setMemoryReview(true);
            }}
          />
        </View>
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

function formatTokens(value: number): string {return value.toLocaleString('zh-CN');}

function UsageRow({label, value}: {label: string; value: string}) {
  return <View style={styles.usageRow}><Text style={ui.label}>{label}</Text><Text style={ui.text}>{value}</Text></View>;
}

function MessageBubble({
  message,
  isLatest,
  retryDisabled,
  onRetry,
  onContinue,
}: {
  message: ChatMessage;
  isLatest: boolean;
  retryDisabled: boolean;
  onRetry: () => void | Promise<void>;
  onContinue: () => void | Promise<void>;
}) {
  const isUser = message.role === 'user';
  const [processOpen, setProcessOpen] = useState(false);
  const display = !isUser && message.status === 'completed' ? splitProcessPreamble(message.content) : {answer: message.content};
  return (
    <View
      accessibilityLabel={`${isUser ? tr('You') : tr('Assistant')} ${tr('Message')}`}
      testID={`message-${message.id}`}
      style={[
        styles.messageBubble,
        isUser ? styles.userMessage : styles.assistantMessage,
      ]}>
      <View style={styles.messageMeta}>
        <Text style={styles.messageRole}>{isUser ? tr('You') : 'CetaMesh'}</Text>
        {message.status !== 'completed' ? (
          <Text style={styles.messageStatus}>{tr(message.status)}</Text>
        ) : null}
      </View>
      {'process' in display && display.process ? (
        <View style={styles.processNotice}>
          <Button title={processOpen ? '收起过程说明' : '过程说明 · 模型文本'} variant="subtle" testID={`message-process-${message.id}`} onPress={() => setProcessOpen(value => !value)} />
          {processOpen ? <Text style={ui.label}>{display.process}</Text> : null}
        </View>
      ) : null}
      {!isUser && message.status === 'completed' && display.answer ? (
        <AssistantMarkdown content={display.answer} />
      ) : (
        <Text selectable style={styles.messageText}>
          {display.answer || (message.status === 'streaming' ? '正在回复…' : '暂无回复')}
        </Text>
      )}
      {!isUser && message.status === 'completed' && message.content ? (
        <Button title="复制" variant="subtle" testID={`message-copy-${message.id}`} style={styles.messageCopy} onPress={() => Clipboard.setString(message.content)} />
      ) : null}
      {message.attachments.map(file => (
        <View key={file.id} style={styles.messageAttachment}>
          <Text style={styles.attachmentGlyph}>↗</Text>
          <Text numberOfLines={1} style={styles.messageAttachmentName}>
            {file.name}
          </Text>
        </View>
      ))}
      {message.errorCode ? (
        <Text accessibilityRole="alert" style={styles.messageError}>
          {message.content ? '回答中断 · ' : ''}{userErrorMessage(message.errorCode)}
        </Text>
      ) : null}
      {isLatest && message.role === 'assistant' &&
      ['failed', 'cancelled'].includes(message.status) ? (
        <View style={styles.retryActions}>
          {message.content ? <Button title="继续生成" variant="subtle" testID="continue-reply" disabled={retryDisabled} onPress={onContinue} /> : null}
          <Button title={message.content ? '重新生成' : tr('Retry response')} variant="subtle" testID="retry" disabled={retryDisabled} onPress={onRetry} style={styles.retryButton} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, minHeight: 0, backgroundColor: colors.background},
  loadingState: {flex: 1, padding: space.lg, gap: space.md, backgroundColor: colors.background},
  conversationHeader: {
    minHeight: 62,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.background,
  },
  conversationHeading: {flex: 1, minWidth: 0, paddingHorizontal: space.xs},
  conversationTitle: {fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.text},
  conversationMeta: {marginTop: 1, fontSize: 11, lineHeight: 15, color: colors.textMuted},
  composerStatusRow: {alignItems: 'center', gap: space.sm, paddingRight: space.md},
  usageButton: {minHeight: 30, paddingVertical: 4},
  usageSheet: {gap: space.md, paddingBottom: space.lg},
  usageRow: {flexDirection: 'row', justifyContent: 'space-between', gap: space.md},
  unsavedNotice: {marginHorizontal: space.md, marginBottom: space.sm, padding: space.sm, borderRadius: radii.sm, backgroundColor: colors.accentSoft},
  unsavedText: {fontSize: 12, lineHeight: 16, color: colors.accent},
  messageList: {flex: 1, minHeight: 0},
  messageListContent: {paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.lg, gap: space.md},
  messageListEmpty: {flexGrow: 1, justifyContent: 'center'},
  emptyConversation: {alignItems: 'center', paddingHorizontal: space.xl, paddingVertical: space.xxl, gap: space.sm},
  emptyMark: {width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft},
  emptyMarkText: {fontSize: 20, fontWeight: '700', color: colors.accent},
  emptyTitle: {marginTop: space.sm, fontSize: 17, lineHeight: 23, fontWeight: '700', color: colors.text},
  emptyCopy: {maxWidth: 260, textAlign: 'center', fontSize: 13, lineHeight: 19, color: colors.textMuted},
  messageBubble: {maxWidth: '92%', padding: space.md, borderRadius: radii.lg, gap: space.sm},
  userMessage: {alignSelf: 'flex-end', borderBottomRightRadius: radii.sm, backgroundColor: colors.accentSoft},
  assistantMessage: {alignSelf: 'stretch', paddingHorizontal: space.sm, backgroundColor: colors.background},
  processNotice: {gap: space.xs},
  messageCopy: {alignSelf: 'flex-start', minHeight: 32, paddingVertical: 3},
  messageMeta: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm},
  messageRole: {fontSize: 11, lineHeight: 15, fontWeight: '700', color: colors.textMuted},
  messageStatus: {fontSize: 11, lineHeight: 15, color: colors.textMuted},
  messageText: {fontSize: 15, lineHeight: 22, color: colors.text},
  messageAttachment: {minHeight: 34, paddingHorizontal: space.sm, borderRadius: radii.sm, flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.surface},
  attachmentGlyph: {fontSize: 14, fontWeight: '700', color: colors.accent},
  messageAttachmentName: {flex: 1, fontSize: 12, lineHeight: 17, color: colors.text},
  messageError: {fontSize: 12, lineHeight: 17, color: colors.danger},
  retryButton: {alignSelf: 'flex-start', minHeight: 36},
  composer: {paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, gap: space.sm},
  attachmentRow: {gap: space.sm, paddingBottom: space.xs},
  composerRow: {flexDirection: 'row', alignItems: 'flex-end', gap: space.sm},
  retryActions: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  composerInput: {flex: 1, minHeight: 44, maxHeight: 132, paddingHorizontal: 13, paddingVertical: 11, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, backgroundColor: colors.background, fontSize: 15, lineHeight: 21, color: colors.text},
  composerHint: {paddingLeft: space.xs, fontSize: 11, lineHeight: 15, color: colors.textMuted},
  memoryDraftHint: {paddingLeft: space.xs, fontSize: 11, lineHeight: 15, color: colors.accent},
  sheetActions: {gap: space.md, paddingBottom: space.md},
  sheetActionTitle: {fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.text},
  unavailableCopy: {paddingTop: space.sm, paddingBottom: space.lg, fontSize: 14, lineHeight: 21, color: colors.textMuted},
  sessionMenu: {gap: space.md, paddingBottom: space.xl},
  menuDivider: {height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: space.xs},
});
