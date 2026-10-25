import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { CetaError } from '../errors/CetaError';
import { Button } from './DesignSystem';
import {colors, radii, space} from './tokens';
import {tr} from '../i18n';
import {userErrorMessage} from '../errors/userMessage';
export function safeError(error: unknown): CetaError {
  return error instanceof CetaError
    ? error
    : new CetaError('unknown', '操作失败，请重试');
}
export function ErrorNotice({ error, friendly = false }: { error?: CetaError; friendly?: boolean }) {
  return error ? (
    <View
      testID="error-notice"
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive">
      <Text style={ui.error}>
        {friendly ? userErrorMessage(error.code) : error.code === 'network_unavailable'
          ? tr('You’re offline. Reconnect and try again.')
          : `${tr('Operation failed. Please try again.')} (${error.code})`}
      </Text>
    </View>
  ) : null;
}
export function Action({
  title,
  onPress,
  testID,
  disabled = false,
  variant = 'secondary',
}: {
  title: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'subtle' | 'danger';
}) {
  return (
    <Button
      title={title}
      variant={variant}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
    />
  );
}
export function Field({
  label,
  value,
  onChangeText,
  testID,
  secure = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  testID?: string;
  secure?: boolean;
}) {
  return (
    <View>
      <Text style={ui.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        testID={testID}
        style={ui.input}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}
export const ui = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  page: { padding: space.lg, gap: space.md },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: colors.text },
  text: { fontSize: 15, lineHeight: 22, color: colors.text },
  label: { fontSize: 13, lineHeight: 18, color: colors.textMuted, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.surface,
    minHeight: 44,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  button: {
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderColor: colors.border,
    borderWidth: 1,
  },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  error: { color: colors.danger, paddingVertical: 8 },
  card: { padding: space.lg, borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface, gap: space.sm },
  grow: { flex: 1 },
});
