import {tr} from '../../shared/i18n';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {CetaError} from '../../shared/errors/CetaError';

type AppBootstrapProps = {
  readonly error?: CetaError;
};

export default function AppBootstrap({error}: AppBootstrapProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>CetaMesh Mobile</Text>
      <Text style={styles.subtitle}>M0 Bootstrap</Text>
      <Text style={styles.status}>{tr('App startup ready')}</Text>
      <Text style={styles.build}>Build: {__DEV__ ? 'Debug' : 'Release'}</Text>
      {error ? (
        <View accessibilityRole="alert" style={styles.error}>
          <Text style={styles.errorCode}>{error.code}</Text>
          <Text style={styles.errorMessage}>{error.message}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#f7f8fa',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#122033',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#49627a',
    fontSize: 18,
    marginTop: 12,
  },
  status: {
    color: '#49627a',
    fontSize: 15,
    marginTop: 24,
  },
  build: {
    color: '#74869a',
    fontSize: 13,
    marginTop: 8,
  },
  error: {
    alignItems: 'center',
    marginTop: 24,
  },
  errorCode: {
    color: '#a32929',
    fontSize: 14,
    fontWeight: '700',
  },
  errorMessage: {
    color: '#a32929',
    fontSize: 14,
    marginTop: 4,
  },
});
