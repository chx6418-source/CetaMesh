import {tr} from '../../shared/i18n';
import React, {useRef, useState} from 'react';
import {Alert, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import type {ProviderConfig} from '../../domain/model/ModelProvider';
import type {MobileServices} from '../../runtime/session/MobileServices';
import {ErrorNotice, Field, safeError, ui} from '../../shared/ui/Controls';
import {Button, Card} from '../../shared/ui/DesignSystem';
import {colors, space} from '../../shared/ui/tokens';
import type {CetaError} from '../../shared/errors/CetaError';
import {newId} from '../../shared/utils/id';

export function ProviderForm({
  services,
  provider,
  onSaved,
  onBack,
}: {
  services: MobileServices;
  provider?: ProviderConfig;
  onSaved: () => Promise<void>;
  onBack: () => void;
}) {
  const [id] = useState(provider?.id ?? newId('provider'));
  const [name, setName] = useState(provider?.name ?? '');
  const [url, setUrl] = useState(provider?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [reasoning, setReasoning] = useState(provider?.supportsReasoning ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CetaError>();
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);

  const save = async () => {
    if (pending.current) {return;}
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    let leaving = false;
    try {
      await services.settings.save({id, name, baseUrl: url, supportsReasoning: reasoning}, key);
      setKey('');
      await services.reloadProviders();
      leaving = true;
      await onSaved();
    } catch (nextError) {
      setKey('');
      setError(safeError(nextError));
    } finally {
      pending.current = false;
      if (!leaving) {setBusy(false);}
    }
  };

  const removeKey = () => {
    Alert.alert('Remove saved API key?', 'The provider remains in Workspace, but chats cannot use it until a key is saved again.', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Remove key',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setError(undefined);
          setSaved(false);
          try {
            await services.settings.removeSecret(id);
            await onSaved();
            setSaved(true);
          } catch (nextError) {
            setError(safeError(nextError));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Button title={tr('Providers')} variant="subtle" testID="back-provider-form" disabled={busy} onPress={onBack} />
      <View style={styles.intro}>
        <Text style={styles.eyebrow}>{provider ? 'MODEL SERVICE' : 'ADD A MODEL SERVICE'}</Text>
        <Text style={ui.title}>{provider ? 'Provider details' : tr('Add provider')}</Text>
        <Text style={ui.text}>{tr('Connect an HTTPS model service. You choose which provider to use for each new conversation.')}</Text>
      </View>

      <Card style={styles.formCard}>
        <Field testID="provider-name" label={tr('Name')} value={name} onChangeText={setName} />
        <Field testID="provider-url" label={tr('Service URL (include /v1 path)')} value={url} onChangeText={setUrl} />
        <Field
          testID="provider-key"
          label={provider ? 'API key (optional if one is already configured)' : 'API key'}
          value={key}
          onChangeText={setKey}
          secure
        />
        <Text style={styles.securityNote}>
          API keys stay in this device’s secure storage. Chat content is sent to the service you configure.
        </Text>
        <View style={styles.switchRow}>
          <View style={styles.switchCopy}>
            <Text style={styles.switchTitle}>{tr('Reasoning support')}</Text>
            <Text style={ui.label}>Enable only when this service accepts reasoning_effort.</Text>
          </View>
          <Switch accessibilityLabel="Supports reasoning effort" value={reasoning} onValueChange={setReasoning} disabled={busy} />
        </View>
      </Card>

      <ErrorNotice error={error} />
      {saved ? <Text accessibilityLiveRegion="polite" style={styles.savedNotice}>{tr('API key removed from secure storage.')}</Text> : null}
      <View style={styles.actions}>
        <Button
          title={busy ? tr('Saving…') : 'Save provider'}
          variant="primary"
          testID="provider-save"
          disabled={busy || !name.trim() || !url.trim() || (!provider && !key.trim())}
          onPress={save}
        />
        {provider ? (
          <Button title={tr('Remove saved API key')} variant="danger" testID="provider-remove-key" disabled={busy} onPress={removeKey} />
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  intro: {gap: space.sm, paddingVertical: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  formCard: {gap: space.md},
  securityNote: {fontSize: 12, lineHeight: 18, color: colors.textMuted},
  switchRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md},
  switchCopy: {flex: 1, gap: space.xs},
  switchTitle: {fontSize: 14, lineHeight: 19, fontWeight: '600', color: colors.text},
  savedNotice: {fontSize: 13, lineHeight: 18, color: colors.success},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
});
