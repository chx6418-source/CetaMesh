import {tr} from '../../shared/i18n';
import React, {useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {ChatSessionConfig} from '../../domain/chat/ChatRepository';
import type {ProviderConfig} from '../../domain/model/ModelProvider';
import type {MobileServices} from '../../runtime/session/MobileServices';
import {Field, ui} from '../../shared/ui/Controls';
import {BottomSheet, Button, Chip} from '../../shared/ui/DesignSystem';
import {colors, space} from '../../shared/ui/tokens';

export function SessionOptions({
  value,
  onChange,
  providers,
  services,
  disabled = false,
  onSave,
  saveTitle = tr('Save session options'),
}: {
  value: ChatSessionConfig;
  onChange: (value: ChatSessionConfig) => void;
  providers: ProviderConfig[];
  services: MobileServices;
  disabled?: boolean;
  onSave?: () => Promise<void> | void;
  saveTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [hint, setHint] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const requestVersion = useRef(0);
  const provider = providers.find(item => item.id === value.modelProviderId);

  useEffect(() => {
    const version = requestVersion;
    version.current++;
    setModels([]);
    setHint('');
    setLoadingModels(false);
    return () => {
      version.current++;
    };
  }, [value.modelProviderId]);

  const loadModels = async () => {
    const providerId = value.modelProviderId;
    const version = ++requestVersion.current;
    setLoadingModels(true);
    setHint('');
    try {
      const list = await services.listModels(providerId);
      if (version !== requestVersion.current) {
        return;
      }
      setModels(list.map(model => model.id));
      setHint(list.length ? '' : tr('No models found. You can enter a model ID.'));
    } catch {
      if (version === requestVersion.current) {
        setHint(tr('Model list unavailable. Check provider access or enter an ID.'));
      }
    } finally {
      if (version === requestVersion.current) {
        setLoadingModels(false);
      }
    }
  };

  return (
    <>
      <View style={styles.summary}>
        <Chip
          label={value.modelId || provider?.name || tr('Choose model')}
          selected
          disabled={disabled}
          testID="session-options-open"
          onPress={() => setOpen(true)}
        />
        <Chip
          label={value.mode === 'smart' ? tr('Smart') : tr('Chat')}
          disabled={disabled}
          testID="session-mode-open"
          onPress={() => setOpen(true)}
        />
        <Chip
          label={`${tr('Reasoning')} · ${tr(value.reasoning)}`}
          disabled={disabled}
          testID="session-reasoning-open"
          onPress={() => setOpen(true)}
        />
      </View>
      <BottomSheet
        visible={open}
        title={tr('Conversation options')}
        onClose={() => setOpen(false)}
        testIDPrefix="session-options-sheet">
        <View style={styles.sheetContent}>
          <View style={styles.optionGroup}>
            <Text style={ui.label}>{tr('Provider')}</Text>
            <View style={styles.chips}>
              {providers.map(item => (
                <Chip
                  key={item.id}
                  label={item.name}
                  selected={value.modelProviderId === item.id}
                  disabled={disabled}
                  testID={`session-provider-${item.id}`}
                  onPress={() => {
                    requestVersion.current++;
                    setModels([]);
                    setHint('');
                    onChange({...value, modelProviderId: item.id, modelId: ''});
                  }}
                />
              ))}
            </View>
          </View>
          <View style={styles.optionGroup}>
            <Text style={ui.label}>{tr('Model')}</Text>
            <Field
              testID="model-id"
              label={tr('Model ID')}
              value={value.modelId}
              onChangeText={modelId => {
                if (!disabled) {
                  onChange({...value, modelId});
                }
              }}
            />
            <Button
              title={loadingModels ? tr('Loading models…') : tr('Browse models')}
              disabled={disabled || loadingModels || !value.modelProviderId}
              testID="session-load-models"
              onPress={loadModels}
            />
            {hint ? <Text style={styles.hint}>{hint}</Text> : null}
            {models.length ? (
              <View style={styles.chips}>
                {models.map(modelId => (
                  <Chip
                    key={modelId}
                    label={modelId}
                    selected={value.modelId === modelId}
                    disabled={disabled}
                    testID={`session-model-${modelId}`}
                    onPress={() => onChange({...value, modelId})}
                  />
                ))}
              </View>
            ) : null}
          </View>
          <View style={styles.optionGroup}>
            <Text style={ui.label}>{tr('Mode')}</Text>
            <View style={styles.chips}>
              {(['chat', 'smart'] as const).map(mode => (
                <Chip
                  key={mode}
                  label={mode === 'smart' ? tr('Smart') : tr('Chat')}
                  selected={value.mode === mode}
                  disabled={disabled}
                  testID={`session-mode-${mode}`}
                  onPress={() => onChange({...value, mode})}
                />
              ))}
            </View>
            <Text style={styles.hint}>
              Smart currently uses the configured model in this mobile release.
            </Text>
          </View>
          <View style={styles.optionGroup}>
            <Text style={ui.label}>{tr('Reasoning')}</Text>
            <View style={styles.chips}>
              {(['fast', 'standard', 'high', 'max'] as const).map(reasoning => (
                <Chip
                  key={reasoning}
                  label={reasoning}
                  selected={value.reasoning === reasoning}
                  disabled={disabled}
                  testID={`session-reasoning-${reasoning}`}
                  onPress={() => onChange({...value, reasoning})}
                />
              ))}
            </View>
          </View>
          {onSave ? (
            <Button
              title={saveTitle}
              variant="primary"
              disabled={disabled}
              testID="save-session-settings"
              onPress={async () => {
                await onSave();
                setOpen(false);
              }}
            />
          ) : null}
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  summary: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm},
  sheetContent: {paddingBottom: space.xl, gap: space.lg},
  optionGroup: {gap: space.sm},
  chips: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm},
  hint: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
});
