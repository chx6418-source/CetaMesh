import {tr} from '../i18n';
import React, {useEffect, useMemo, useState} from 'react';
import {BookOpen, LayoutGrid, ListTodo, MessageCircle} from 'lucide-react-native';
import {t} from '../i18n';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {colors, radii, space} from './tokens';

export type PrimaryTab = 'chat' | 'tasks' | 'memory' | 'workspace';
type TabItem = {id: PrimaryTab; label: string};

const primaryTabs: TabItem[] = [
  {id: 'chat', label: t('chat')},
  {id: 'tasks', label: t('tasks')},
  {id: 'memory', label: t('memory')},
  {id: 'workspace', label: t('workspace')},
];

export function Button({
  title,
  onPress,
  variant = 'secondary',
  disabled = false,
  testID,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'subtle' | 'danger';
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({pressed}) => [
        styles.button,
        styles[`button_${variant}`],
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.disabled,
        style,
      ]}>
      <Text style={[styles.buttonText, styles[`buttonText_${variant}`]]}>
        {title}
      </Text>
    </Pressable>
  );
}

export function LoadingState({
  label,
  testID,
  style,
}: {
  label: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      accessibilityState={{busy: true}}
      testID={testID}
      style={[styles.loadingState, style]}>
      <ActivityIndicator color={colors.accent} accessible={false} />
      <Text accessible={false} style={styles.loadingText}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  title,
  description,
  icon = '·',
  testID,
  children,
  style,
}: {
  title: string;
  description: string;
  icon?: string;
  testID?: string;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card testID={testID} style={[styles.emptyState, style]}>
      <View accessible={false} style={styles.emptyMark}>
        <Text style={styles.emptyMarkText}>{icon}</Text>
      </View>
      <Text accessibilityRole="header" style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDescription}>{description}</Text>
      {children}
    </Card>
  );
}

export function Card({
  children,
  testID,
  style,
}: {
  children: React.ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View testID={testID} style={[styles.card, style]}>
      {children}
    </View>
  );
}

export function Chip({
  label,
  selected = false,
  onPress,
  testID,
  disabled = false,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected, disabled}}
      disabled={disabled}
      hitSlop={{top: 5, bottom: 5, left: 0, right: 0}}
      onPress={onPress}
      testID={testID}
      style={({pressed}) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && !disabled && styles.chipPressed,
        disabled && styles.disabled,
      ]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Header({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        <View style={styles.brandRow}>
          <View accessible={false} style={styles.brandMark}>
            <Text style={styles.brandMarkText}>C</Text>
          </View>
          <Text style={styles.brandName}>CetaMesh</Text>
        </View>
        <Text accessibilityRole="header" style={styles.headerTitle}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

function TabGlyph({tab, selected}: {tab: PrimaryTab; selected: boolean}) {
  const color = selected ? colors.accent : colors.textMuted;
  const Icon = {chat: MessageCircle, tasks: ListTodo, memory: BookOpen, workspace: LayoutGrid}[tab];
  return <Icon testID={`tab-icon-${tab}`} size={23} strokeWidth={1.8} color={color} />;
}

export function BottomNavigation({
  activeTab,
  onTabChange,
}: {
  activeTab: PrimaryTab;
  onTabChange: (tab: PrimaryTab) => void;
}) {
  return (
    <View accessibilityRole="tablist" accessibilityLabel={t('primaryNavigation')} style={styles.navigation}>
      {primaryTabs.map(tab => {
        const selected = activeTab === tab.id;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{selected}}
            onPress={() => onTabChange(tab.id)}
            testID={`tab-${tab.id}`}
            style={({pressed}) => [
              styles.navItem,
              selected && styles.navItemSelected,
              pressed && styles.navItemPressed,
            ]}>
            <TabGlyph tab={tab.id} selected={selected} />
            <Text style={[styles.navLabel, selected && styles.navLabelSelected]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function MobileShell({
  activeTab,
  title,
  subtitle,
  onTabChange,
  children,
}: {
  activeTab: PrimaryTab;
  title: string;
  subtitle?: string;
  onTabChange: (tab: PrimaryTab) => void;
  children: React.ReactNode;
}) {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => {show.remove(); hide.remove();};
  }, []);
  return (
    <View style={styles.shell}>
      <Header title={title} subtitle={subtitle} />
      <View style={styles.content}>{children}</View>
      {!keyboardOpen ? <BottomNavigation activeTab={activeTab} onTabChange={onTabChange} /> : null}
    </View>
  );
}

export function BottomSheet({
  visible,
  title,
  onClose,
  children,
  testIDPrefix = 'bottom-sheet',
  clearBackdrop = false,
  hideCloseButton = false,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  testIDPrefix?: string;
  clearBackdrop?: boolean;
  hideCloseButton?: boolean;
}) {
  const handleGesture = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderRelease: (_, gesture) => {if (gesture.dy > 64) {onClose();}},
  }), [onClose]);
  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={onClose}
      testID={`${testIDPrefix}-modal`}>
      <View style={[styles.sheetBackdrop, clearBackdrop && styles.sheetBackdropClear]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('Close sheet')}
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          testID={`${testIDPrefix}-backdrop`}
        />
        <View
          accessibilityViewIsModal
          style={styles.sheet}
          testID={`${testIDPrefix}-content`}>
          <View style={styles.sheetHandleTouch} {...handleGesture.panHandlers} testID={`${testIDPrefix}-drag-handle`}>
            <View style={styles.sheetHandle} />
          </View>
          <View style={styles.sheetHeader}>
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {title}
            </Text>
            {!hideCloseButton ? <Pressable
              accessibilityRole="button"
              accessibilityLabel={tr('Close sheet')}
              hitSlop={8}
              onPress={onClose}
              style={styles.sheetClose}
              testID={`${testIDPrefix}-close`}>
              <Text style={styles.sheetCloseText}>×</Text>
            </Pressable> : null}
          </View>
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  shell: {flex: 1, backgroundColor: colors.background},
  content: {flex: 1, minHeight: 0, backgroundColor: colors.background},
  header: {
    minHeight: 82,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerCopy: {flex: 1, minWidth: 0},
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  brandMark: {
    width: 18,
    height: 18,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  brandMarkText: {fontSize: 11, lineHeight: 14, fontWeight: '700', color: colors.white},
  brandName: {fontSize: 11, fontWeight: '600', letterSpacing: 0.3, color: colors.textMuted},
  headerTitle: {marginTop: 3, fontSize: 19, lineHeight: 24, fontWeight: '700', color: colors.text},
  headerSubtitle: {marginTop: 1, fontSize: 12, lineHeight: 16, color: colors.textMuted},
  headerRight: {marginLeft: space.md, alignItems: 'flex-end'},
  navigation: {
    minHeight: 66,
    paddingHorizontal: 6,
    paddingTop: 6,
    paddingBottom: 5,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-around',
  },
  navItem: {
    flex: 1,
    minWidth: 0,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  navItemSelected: {backgroundColor: colors.accentSoft},
  navItemPressed: {opacity: 0.78},
  navLabel: {fontSize: 11, lineHeight: 14, fontWeight: '500', color: colors.textMuted},
  navLabelSelected: {fontWeight: '700', color: colors.accent},
  button: {
    minHeight: 44,
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button_primary: {backgroundColor: colors.accent, borderColor: colors.accent},
  button_secondary: {backgroundColor: colors.surface, borderColor: colors.border},
  button_subtle: {backgroundColor: colors.surfaceMuted, borderColor: colors.surfaceMuted},
  button_danger: {backgroundColor: colors.dangerSoft, borderColor: colors.dangerSoft},
  buttonText: {fontSize: 14, lineHeight: 20, fontWeight: '600'},
  buttonText_primary: {color: colors.white},
  buttonText_secondary: {color: colors.text},
  buttonText_subtle: {color: colors.text},
  buttonText_danger: {color: colors.danger},
  buttonPressed: {opacity: 0.82},
  disabled: {opacity: 0.48},
  card: {
    padding: space.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: space.sm,
  },
  chip: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: {backgroundColor: colors.accentSoft},
  chipPressed: {opacity: 0.78},
  chipText: {fontSize: 12, lineHeight: 16, fontWeight: '500', color: colors.textMuted},
  chipTextSelected: {fontWeight: '700', color: colors.accent},
  sheetBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(20, 31, 39, 0.42)'},
  sheetBackdropClear: {backgroundColor: 'transparent'},
  sheet: {
    maxHeight: '78%',
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: colors.surface,
  },
  sheetHandleTouch: {height: 20, alignItems: 'center', justifyContent: 'flex-start'},
  sheetHandle: {width: 36, height: 4, borderRadius: radii.pill, backgroundColor: colors.border},
  sheetHeader: {minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  sheetTitle: {flex: 1, fontSize: 17, lineHeight: 23, fontWeight: '700', color: colors.text},
  sheetClose: {width: 36, height: 36, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted},
  sheetCloseText: {fontSize: 24, lineHeight: 28, fontWeight: '400', color: colors.textMuted},
  sheetContent: {paddingTop: space.md, gap: space.md},
  loadingState: {minHeight: 96, alignItems: 'center', justifyContent: 'center', gap: space.sm},
  loadingText: {fontSize: 13, lineHeight: 19, color: colors.textMuted},
  emptyState: {alignItems: 'center', paddingVertical: space.xl, gap: space.sm},
  emptyMark: {width: 42, height: 42, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft},
  emptyMarkText: {fontSize: 18, lineHeight: 24, fontWeight: '700', color: colors.accent},
  emptyTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  emptyDescription: {maxWidth: 280, textAlign: 'center', fontSize: 13, lineHeight: 19, color: colors.textMuted},
});
