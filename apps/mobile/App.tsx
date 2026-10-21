/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import {StatusBar, StyleSheet} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import MobileApp from './src/app/bootstrap/MobileApp';
import { SafeAreaView } from 'react-native-safe-area-context';
import {colors} from './src/shared/ui/tokens';

export const appStatusBarProps = {
  barStyle: 'dark-content' as const,
  backgroundColor: colors.surface,
};

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar {...appStatusBarProps} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  return (
    <SafeAreaView style={styles.container}>
      <MobileApp />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
