import {tr} from '../../shared/i18n';
import React, { useEffect, useState } from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type { MobileServices } from '../../runtime/session/MobileServices';
import { CetaError } from '../../shared/errors/CetaError';
import { ChatHome } from '../../features/chat/ChatHome';
import { ErrorNotice } from '../../shared/ui/Controls';
import {Button, Card, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, space} from '../../shared/ui/tokens';
const defaultLoad = async () =>
  (await import('./createServices')).createServices();
export default function MobileApp({
  load = defaultLoad,
}: {
  load?: () => Promise<MobileServices>;
}) {
  const [services, setServices] = useState<MobileServices>();
  const [error, setError] = useState<CetaError>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    let ready: MobileServices | undefined;
    setError(undefined);
    load()
      .then(value => {
      ready = value;
      if (mounted) {
        setServices(value);
        value.backgroundCatchup.resume().catch(() => undefined);
      } else {
          value.close().catch(() => undefined);
        }
      })
      .catch(() => {
        if (mounted) {
          setError(
            new CetaError(
              'storage_error',
              '初始化失败，数据未被删除。请重试。',
            ),
          );
        }
      });
    return () => {
      mounted = false;
      ready?.close().catch(() => undefined);
    };
  }, [load, attempt]);
  if (services) {
    return <ChatHome services={services} />;
  }
  return (
    <View style={styles.root}>
      <Card style={styles.startupCard}>
        <Text accessibilityRole="header" style={styles.title}>CetaMesh Mobile</Text>
        {error ? (
          <ErrorNotice error={error} />
        ) : (
          <LoadingState label={tr('Preparing your workspace…')} testID="mobile-app-loading" />
        )}
        {error ? (
          <Button
            title={tr('Try again')}
            testID="mobile-app-retry"
            onPress={() => setAttempt(a => a + 1)}
          />
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, justifyContent: 'center', padding: space.lg, backgroundColor: colors.background},
  startupCard: {alignItems: 'center', paddingVertical: space.xl},
  title: {fontSize: 20, lineHeight: 26, fontWeight: '700', color: colors.text},
});
