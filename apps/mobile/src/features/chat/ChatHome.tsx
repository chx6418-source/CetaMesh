import {tr} from '../../shared/i18n';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileServices} from '../../runtime/session/MobileServices';
import type {ChatSession, ChatSessionConfig} from '../../domain/chat/ChatRepository';
import type {ProviderConfig} from '../../domain/model/ModelProvider';
import type {CetaError} from '../../shared/errors/CetaError';
import {Action, ErrorNotice, safeError, ui} from '../../shared/ui/Controls';
import {Button, Card, EmptyState, LoadingState, MobileShell, type PrimaryTab} from '../../shared/ui/DesignSystem';
import {colors, space} from '../../shared/ui/tokens';
import {ProvidersScreen} from '../profile/ProvidersScreen';
import {SessionOptions} from './SessionOptions';
import {ChatScreen} from './ChatScreen';
import {MemoryScreen} from '../memory/MemoryScreen';
import {TasksScreen} from '../tasks/TasksScreen';
import {DevicesScreen} from '../devices/DevicesScreen';
import {ExtensionsScreen} from '../extensions/ExtensionsScreen';
import {AboutAppScreen} from '../about/AboutAppScreen';
import {ChevronRight, Info} from 'lucide-react-native';
import {DEFAULT_NEW_CHAT_CONFIG} from '../../domain/preferences/MobilePreferencesRepository';

const tabTitles: Record<PrimaryTab, string> = {
  chat: tr('A clear space to think.'),
  tasks: tr('Tasks'),
  memory: tr('Memory'),
  workspace: tr('Workspace'),
};

const tabSubtitles: Record<PrimaryTab, string> = {
  chat: '',
  tasks: tr('Work that continues beyond a chat'),
  memory: tr('Notes saved on this device'),
  workspace: tr('Services, devices, and app setup'),
};

type PendingMemoryDraft = {sessionId?: string; content: string};

export function ChatHome({services}: {services: MobileServices}) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [config, setConfig] = useState<ChatSessionConfig>({...DEFAULT_NEW_CHAT_CONFIG});
  const [activeTab, setActiveTab] = useState<PrimaryTab>('chat');
  const [selected, setSelected] = useState<string>();
  const [memoryDraft, setMemoryDraft] = useState<PendingMemoryDraft>();
  const [settings, setSettings] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [defaultsSaved, setDefaultsSaved] = useState(false);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<CetaError>();
  const [providersError, setProvidersError] = useState<CetaError>();
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersLoadFailed, setProvidersLoadFailed] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsLoadFailed, setSessionsLoadFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const pagePending = useRef(false);
  const listVersion = useRef(0);
  const preferencesLoaded = useRef(false);

  const reloadProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersLoadFailed(false);
    setProvidersError(undefined);
    try {
      let list: ProviderConfig[];
      try {
        list = await services.settings.list();
      } catch (nextError) {
        setProvidersLoadFailed(true);
        setProvidersError(safeError(nextError));
        throw nextError;
      }
      setProviders(list);
      if (!preferencesLoaded.current) {
        const saved = await services.preferences.getNewChatDefaults();
        preferencesLoaded.current = true;
        const selectedProviderId = list.some(item => item.id === saved.modelProviderId)
          ? saved.modelProviderId
          : list[0]?.id ?? '';
        setConfig({...saved, modelProviderId: selectedProviderId, modelId: selectedProviderId === saved.modelProviderId ? saved.modelId : ''});
        return;
      }
      setConfig(current => {
        if (list.some(item => item.id === current.modelProviderId)) {return current;}
        return {...current, modelProviderId: list[0]?.id ?? '', modelId: ''};
      });
    } finally {
      setProvidersLoading(false);
    }
  }, [services]);

  const reloadSessions = useCallback(async () => {
    const version = ++listVersion.current;
    setSessionsLoading(true);
    setSessionsLoadFailed(false);
    try {
      const list = await services.sessions.list({archived, limit: 30});
      if (version !== listVersion.current) {
        return;
      }
      setSessions(list);
      setHasMore(list.length === 30);
    } catch (nextError) {
      if (version === listVersion.current) {
        setSessionsLoadFailed(true);
      }
      throw nextError;
    } finally {
      if (version === listVersion.current) {
        setSessionsLoading(false);
      }
    }
  }, [archived, services]);

  useEffect(() => {
    const version = listVersion;
    reloadProviders().catch(nextError => setError(safeError(nextError)));
    reloadSessions().catch(nextError => setError(safeError(nextError)));
    return () => {
      version.current++;
    };
  }, [reloadProviders, reloadSessions]);

  const navigate = (tab: PrimaryTab) => {
    setActiveTab(tab);
    setSettings(false);
    setDevicesOpen(false);
    setExtensionsOpen(false);
  };

  const createChat = async () => {
    setError(undefined);
    try {
      const session = await services.sessions.create(config);
      setMemoryDraft(current =>
        current && !current.sessionId
          ? {...current, sessionId: session.id}
          : current,
      );
      setSelected(session.id);
    } catch (nextError) {
      setError(safeError(nextError));
    }
  };

  const toggleArchived = () => {
    listVersion.current++;
    setArchived(current => !current);
  };

  const useMemoryInChat = (sessionId: string | undefined, content: string) => {
    setMemoryDraft({sessionId, content});
    setSelected(sessionId);
    navigate('chat');
  };

  const saveNewChatDefaults = async () => {
    await services.preferences.saveNewChatDefaults(config);
    setDefaultsSaved(true);
  };

  const changeNewChatDefaults = (next: ChatSessionConfig) => {
    setConfig(next);
    setDefaultsSaved(false);
  };

  let content: React.ReactNode;
  if (activeTab === 'chat') {
    content = selected ? (
      <ChatScreen
        key={selected}
        id={selected}
        services={services}
        providers={providers}
        initialDraft={memoryDraft?.sessionId === selected ? memoryDraft.content : undefined}
        onDraftChange={draft => {
          setMemoryDraft(current => {
            if (!current || current.sessionId !== selected) {return current;}
            return draft ? {...current, content: draft} : undefined;
          });
        }}
        onMemoryDraftSent={() => {
          setMemoryDraft(current => current?.sessionId === selected ? undefined : current);
        }}
        onBack={() => {
          setSelected(undefined);
          reloadSessions().catch(nextError => setError(safeError(nextError)));
        }}
      />
    ) : (
      <ScrollView
        contentContainerStyle={ui.page}
        keyboardShouldPersistTaps="handled">
        <View style={styles.intro}>
          <Text style={ui.title}>CetaMesh · {tr('A clear space to think.')}</Text>
        </View>

        {memoryDraft && !memoryDraft.sessionId ? (
          <Card testID="memory-draft-pending" style={styles.memoryDraftCard}>
            <View style={styles.memoryDraftCopy}>
              <Text style={styles.sectionTitle}>{tr('Memory ready for a draft')}</Text>
              <Text numberOfLines={3} style={ui.label}>{memoryDraft.content}</Text>
              <Text style={ui.label}>{tr('Review and edit it before sending.')}</Text>
            </View>
            {providers.length ? (
              <Button title={tr('Start a chat')} testID="memory-draft-new-chat" onPress={createChat} />
            ) : providersLoading ? (
              <Text style={ui.label}>{tr('Checking available providers…')}</Text>
            ) : (
              <Text style={ui.label}>
                {providersLoadFailed
                  ? tr('Provider status could not be checked. This draft is kept.')
                  : tr('Connect a provider to start a conversation. This draft is kept.')}
              </Text>
            )}
          </Card>
        ) : null}

        {providersLoading ? (
          <LoadingState label={tr('Loading model providers…')} testID="providers-loading" />
        ) : providers.length ? (
          <Card testID="new-chat-card">
            <Text style={styles.sectionTitle}>{tr('Start a conversation')}</Text>
            <SessionOptions
              value={config}
              onChange={setConfig}
              providers={providers}
              services={services}
            />
            <Button
              title={tr('New chat')}
              variant="primary"
              testID="new-chat"
              onPress={createChat}
            />
          </Card>
        ) : !providersLoadFailed ? (
          <EmptyState
            testID="provider-empty-state"
            title={tr('Connect a provider')}
            description={tr('Add a compatible model provider in Workspace to start a private conversation.')}
          >
            <Button
              title={tr('Configure provider')}
              variant="primary"
              testID="open-provider-setup"
              onPress={() => {
                setActiveTab('workspace');
                setSettings(true);
              }}
            />
          </EmptyState>
        ) : null}

        <View style={styles.sectionHeading}>
          <View>
            <Text style={styles.sectionTitle}>{tr('Recent sessions')}</Text>
            <Text style={styles.sectionNote}>
              {archived ? 'Archived' : tr('Your conversations')}
            </Text>
          </View>
          <Button
            title={archived ? tr('Show active') : 'Archived'}
            variant="subtle"
            onPress={toggleArchived}
          />
        </View>

        <ErrorNotice error={error} />
        {sessionsLoading ? (
          <LoadingState label={archived ? tr('Loading archived conversations…') : tr('Loading conversations…')} testID="sessions-loading" />
        ) : sessions.length ? (
          sessions.map(session => (
            <Card key={session.id}>
              <Action
                testID={`session-${session.id}`}
                title={session.title}
                onPress={() => {
                  setMemoryDraft(current =>
                    current && !current.sessionId
                      ? {...current, sessionId: session.id}
                      : current,
                  );
                  setSelected(session.id);
                }}
              />
              <Text style={ui.label}>
                {session.config.modelId || tr('Model not selected')}
                {'  ·  '}
                {tr(session.config.mode === 'smart' ? 'Smart' : 'Chat')}
              </Text>
            </Card>
          ))
        ) : !sessionsLoadFailed ? (
          <EmptyState
            testID="sessions-empty-state"
            title={tr('No sessions yet')}
            description={tr('Start a new conversation and it will appear here.')}
          />
        ) : null}
        {hasMore ? (
          <Action
            title={loadingPage ? 'Loading…' : tr('Load more sessions')}
            testID="sessions-load-more"
            disabled={loadingPage}
            onPress={async () => {
              if (pagePending.current) {
                return;
              }
              pagePending.current = true;
              setLoadingPage(true);
              const version = listVersion.current;
              try {
                const page = await services.sessions.list({
                  archived,
                  limit: 30,
                  offset: sessions.length,
                });
                if (version !== listVersion.current) {
                  return;
                }
                setSessions(current => {
                  const ids = new Set(current.map(session => session.id));
                  return [...current, ...page.filter(session => !ids.has(session.id))];
                });
                setHasMore(page.length === 30);
              } catch (nextError) {
                if (version === listVersion.current) {
                  setError(safeError(nextError));
                }
              } finally {
                pagePending.current = false;
                setLoadingPage(false);
              }
            }}
          />
        ) : null}
      </ScrollView>
    );
  } else if (activeTab === 'tasks') {
    content = <TasksScreen services={services} />;
  } else if (activeTab === 'memory') {
    content = (
      <MemoryScreen
        services={services}
        onOpenChat={id => {
          setSelected(id);
          navigate('chat');
        }}
        onUseInChat={useMemoryInChat}
      />
    );
  } else if (aboutOpen) {
    content = <AboutAppScreen version={services.appVersion} updates={services.updates} onBack={() => setAboutOpen(false)} />;
  } else if (extensionsOpen) {
    content = <ExtensionsScreen services={services} onBack={() => setExtensionsOpen(false)} />;
  } else if (devicesOpen) {
    content = (
      <DevicesScreen services={services} onBack={() => setDevicesOpen(false)} />
    );
  } else if (settings) {
    content = (
      <ProvidersScreen
        services={services}
        providers={providers}
        loading={providersLoading}
        error={providersError}
        onProvidersChanged={reloadProviders}
        onBack={() => setSettings(false)}
      />
    );
  } else {
    content = (
      <WorkspaceHome
        services={services}
        providers={providers}
        providersLoading={providersLoading}
        providersLoadFailed={providersLoadFailed}
        config={config}
        defaultsSaved={defaultsSaved}
        onConfigChange={changeNewChatDefaults}
        onSaveDefaults={saveNewChatDefaults}
        onOpenProviders={() => setSettings(true)}
        onOpenDevices={() => setDevicesOpen(true)}
        onOpenExtensions={() => setExtensionsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
      />
    );
  }

  return (
    <MobileShell
      activeTab={activeTab}
      title={tabTitles[activeTab]}
      subtitle={tabSubtitles[activeTab]}
      onTabChange={navigate}>
      <View style={styles.tabContent}>{content}</View>
    </MobileShell>
  );
}

function WorkspaceHome({
  services,
  providers,
  providersLoading,
  providersLoadFailed,
  config,
  defaultsSaved,
  onConfigChange,
  onSaveDefaults,
  onOpenProviders,
  onOpenDevices,
  onOpenExtensions,
  onOpenAbout,
}: {
  services: MobileServices;
  providers: ProviderConfig[];
  providersLoading: boolean;
  providersLoadFailed: boolean;
  config: ChatSessionConfig;
  defaultsSaved: boolean;
  onConfigChange: (config: ChatSessionConfig) => void;
  onSaveDefaults: () => Promise<void>;
  onOpenProviders: () => void;
  onOpenDevices: () => void;
  onOpenExtensions: () => void;
  onOpenAbout: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.workspacePage}>
      <View style={styles.workspaceSectionHeader}>
        <Text style={styles.sectionTitle}>AI</Text>
        <Text style={ui.label}>{tr('Providers and new conversation defaults')}</Text>
      </View>
      <Card style={styles.workspaceCard}>
        <View style={styles.workspaceRow}>
          <View style={styles.workspaceCopy}>
            <Text style={styles.workspaceCardTitle}>{tr('Model providers')}</Text>
            <Text style={ui.label}>
              {providersLoading
                ? tr('Checking configured providers…')
                : providersLoadFailed
                  ? tr('Provider list could not be loaded')
                  : providers.length
                ? `已配置 ${providers.length} 个模型服务`
                : tr('No providers configured')}
            </Text>
          </View>
          <Button
            title={providersLoading ? tr('Checking') : providersLoadFailed ? tr('Retry') : providers.length ? tr('Manage') : tr('Add provider')}
            variant="secondary"
            testID="settings"
            disabled={providersLoading}
            onPress={onOpenProviders}
          />
        </View>
        <View style={styles.workspaceDivider} />
        <View style={styles.defaultsCopy}>
          <Text style={styles.workspaceCardTitle}>{tr('New conversation defaults')}</Text>
          <Text style={ui.label}>{tr('Choose the starting model, mode, and reasoning level.')}</Text>
        </View>
        <SessionOptions
          value={config}
          onChange={onConfigChange}
          providers={providers}
          services={services}
          onSave={onSaveDefaults}
          saveTitle={tr('Save new-chat defaults')}
        />
        {defaultsSaved ? <Text accessibilityLiveRegion="polite" style={styles.savedNotice}>{tr('Saved on this device')}</Text> : null}
      </Card>

      <View style={styles.workspaceSectionHeader}>
        <Text style={styles.sectionTitle}>{tr('Devices')}</Text>
        <Text style={ui.label}>{tr('This phone and trusted CetaMesh nodes')}</Text>
      </View>
      <Card style={styles.workspaceCard}>
        <View style={styles.workspaceRow}>
          <View style={styles.workspaceCopy}>
            <Text style={styles.workspaceCardTitle}>{tr('Device connections')}</Text>
            <Text style={ui.label}>{tr('Pair a Desktop node or review trusted devices.')}</Text>
          </View>
          <Button
            title={tr('Manage')}
            variant="secondary"
            testID="open-devices"
            onPress={onOpenDevices}
          />
        </View>
      </Card>

      <View style={styles.workspaceSectionHeader}>
        <Text style={styles.sectionTitle}>{tr('Extensions')}</Text>
        <Text style={ui.label}>{tr('Installed tools and their permissions')}</Text>
      </View>
      <Card testID="extension-management-info" style={styles.workspaceCard}>
        <Text style={styles.workspaceCardTitle}>{tr('Extension management')}</Text>
        <Text style={ui.label}>{tr('Review installed tools, their access, and updates.')}</Text>
        <Button title={tr('Manage extensions')} variant="secondary" testID="open-extensions" onPress={onOpenExtensions} />
      </Card>

      <View style={styles.workspaceSectionHeader}>
        <Text style={styles.sectionTitle}>{tr('Preferences')}</Text>
        <Text style={ui.label}>{tr('Privacy and app behavior')}</Text>
      </View>
      <Card style={styles.workspaceCard}>
        <View style={styles.preferenceRow}>
          <Text style={styles.preferenceLabel}>{tr('Appearance')}</Text>
          <Text style={styles.preferenceValue}>{tr('Light')}</Text>
        </View>
        <View style={styles.preferenceRow}>
          <Text style={styles.preferenceLabel}>{tr('Memory')}</Text>
          <Text style={styles.preferenceValue}>{tr('Local to this device')}</Text>
        </View>
        <Text style={styles.privacyNote}>{tr('Provider keys use secure storage. Chat content is sent only to the provider selected for that conversation.')}</Text>
      </Card>

      <Card style={styles.workspaceCard}>
        <Text style={styles.workspaceCardTitle}>{tr('Advanced')}</Text>
        <Text style={ui.label}>{tr('CetaMesh Mobile operates independently; pairing adds trusted device connections without changing local Memory scope.')}</Text>
      </Card>
      <Card style={styles.workspaceCard}>
        <Pressable accessibilityRole="button" accessibilityLabel="关于应用" testID="open-about" onPress={onOpenAbout} style={styles.workspaceRow}>
          <Info size={21} color={colors.accent} />
          <View style={styles.workspaceCopy}><Text style={styles.workspaceCardTitle}>关于应用</Text><Text style={ui.label}>应用信息、版本与更新</Text></View>
          <ChevronRight size={19} color={colors.textMuted} />
        </Pressable>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tabContent: {flex: 1, minHeight: 0},
  intro: {gap: space.sm, paddingBottom: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  sectionHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, marginTop: space.xs},
  sectionTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  sectionNote: {marginTop: 2, fontSize: 12, lineHeight: 17, color: colors.textMuted},
  memoryDraftCard: {gap: space.md, borderColor: colors.accent},
  memoryDraftCopy: {gap: space.xs},
  workspacePage: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  workspaceSectionHeader: {gap: space.xs, marginTop: space.sm},
  workspaceCard: {gap: space.md},
  workspaceRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md},
  workspaceCopy: {flex: 1, gap: space.xs},
  workspaceCardTitle: {fontSize: 14, lineHeight: 19, fontWeight: '700', color: colors.text},
  workspaceDivider: {height: StyleSheet.hairlineWidth, backgroundColor: colors.border},
  defaultsCopy: {gap: space.xs},
  preferenceRow: {flexDirection: 'row', justifyContent: 'space-between', gap: space.md},
  preferenceLabel: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  preferenceValue: {fontSize: 12, lineHeight: 17, fontWeight: '600', color: colors.text},
  privacyNote: {fontSize: 12, lineHeight: 18, color: colors.textMuted},
  savedNotice: {fontSize: 12, lineHeight: 17, color: colors.success},
});
