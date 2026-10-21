import {tr} from '../../shared/i18n';
import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {ProviderConfig} from '../../domain/model/ModelProvider';
import type {MobileServices} from '../../runtime/session/MobileServices';
import type {CetaError} from '../../shared/errors/CetaError';
import {ErrorNotice, ui} from '../../shared/ui/Controls';
import {Button, Card, EmptyState, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, space} from '../../shared/ui/tokens';
import {ProviderForm} from './ProviderForm';

export function ProvidersScreen({
  services,
  providers,
  loading = false,
  error,
  onProvidersChanged,
  onBack,
}: {
  services: MobileServices;
  providers: ProviderConfig[];
  loading?: boolean;
  error?: CetaError;
  onProvidersChanged: () => Promise<void>;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<ProviderConfig>();
  const [creating, setCreating] = useState(false);

  if (creating || selected) {
    return (
      <ProviderForm
        key={selected?.id ?? 'new'}
        services={services}
        provider={selected}
        onBack={() => {
          setSelected(undefined);
          setCreating(false);
        }}
        onSaved={async () => {
          await onProvidersChanged();
          setSelected(undefined);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Button title={tr('Workspace')} variant="subtle" testID="back-workspace" onPress={onBack} />
      <View style={styles.intro}>
        <Text style={styles.eyebrow}>{tr('AI SERVICES')}</Text>
        <Text style={ui.title}>{tr('Providers')}</Text>
        <Text style={ui.text}>{tr('Manage the services available to your conversations.')}</Text>
      </View>

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{tr('Model providers')}</Text>
        <Text style={ui.label}>
          {loading ? 'Checking providers…' : error ? 'Provider list unavailable' : `${providers.length} configured`}
        </Text>
      </View>
      <ErrorNotice error={error} />
      {loading && !providers.length ? (
        <LoadingState label={tr('Loading providers…')} testID="providers-loading" />
      ) : null}
      {!loading && !error && !providers.length ? (
        <EmptyState
          testID="providers-empty-state"
          icon="AI"
          title={tr('No providers yet')}
          description={tr('Add an HTTPS model service to start a conversation.')}
        >
          <Button title={tr('Add provider')} testID="provider-add" onPress={() => setCreating(true)} />
        </EmptyState>
      ) : null}
      {error ? (
        <Button
          title={tr('Retry provider check')}
          variant="subtle"
          testID="providers-retry"
          disabled={loading}
          onPress={() => {onProvidersChanged().catch(() => undefined);}}
        />
      ) : null}

      {providers.map(provider => (
        <Card key={provider.id} style={styles.providerCard}>
          <View style={styles.providerHeader}>
            <View style={styles.providerCopy}>
              <Text style={styles.providerName}>{provider.name}</Text>
              <Text numberOfLines={1} style={styles.providerUrl}>{provider.baseUrl}</Text>
            </View>
            <Text style={[styles.statusBadge, provider.supportsReasoning && styles.reasoningBadge]}>
              {provider.supportsReasoning ? 'Reasoning' : tr('Chat')}
            </Text>
          </View>
          <Text style={styles.credentialNote}>{tr('API keys stay out of the provider list.')}</Text>
          <Button
            title={tr('Manage provider')}
            variant="subtle"
            testID={`provider-${provider.id}`}
            onPress={() => setSelected(provider)}
          />
        </Card>
      ))}

      {providers.length ? (
        <Button title={tr('Add provider')} variant="secondary" testID="provider-add" onPress={() => setCreating(true)} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  intro: {gap: space.sm, paddingVertical: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  sectionHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, marginTop: space.sm},
  sectionTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  providerCard: {gap: space.md},
  providerHeader: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm},
  providerCopy: {flex: 1, gap: space.xs},
  providerName: {fontSize: 15, lineHeight: 21, fontWeight: '700', color: colors.text},
  providerUrl: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  statusBadge: {overflow: 'hidden', borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: colors.surfaceMuted, color: colors.textMuted, fontSize: 11, lineHeight: 16, fontWeight: '600'},
  reasoningBadge: {backgroundColor: colors.accentSoft, color: colors.accent},
  credentialNote: {fontSize: 11, lineHeight: 15, color: colors.textMuted},
});
