import React, {useEffect, useState} from 'react';
import {Linking, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Bell, ChevronRight, Download, RefreshCw} from 'lucide-react-native';
import {Button, Card} from '../../shared/ui/DesignSystem';
import {colors, space} from '../../shared/ui/tokens';
import {unconfiguredUpdateService, type UpdateAnnouncement, type UpdateService} from '../../domain/update/UpdateService';

export function AboutAppScreen({onBack, version = '—', updates = unconfiguredUpdateService}: {onBack: () => void; version?: string; updates?: UpdateService}) {
  const [page, setPage] = useState<'about' | 'announcements'>('about');
  const [message, setMessage] = useState('');
  const [latest, setLatest] = useState<string>();
  const [notes, setNotes] = useState<UpdateAnnouncement[]>([]);
  useEffect(() => {
    if (page !== 'announcements') {return;}
    let active = true;
    Promise.all([updates.getLatestVersion(), updates.getReleaseNotes()]).then(([nextVersion, nextNotes]) => {
      if (active) {setLatest(nextVersion); setNotes(nextNotes);}
    }).catch(() => {if (active) {setMessage('无法加载更新公告');}});
    return () => {active = false;};
  }, [page, updates]);

  return <ScrollView contentContainerStyle={styles.page} testID="about-app-screen">
    <Button title={page === 'about' ? '工作区' : '关于应用'} variant="subtle" testID="about-back" onPress={() => page === 'about' ? onBack() : setPage('about')} />
    <Text style={styles.title}>{page === 'about' ? '关于应用' : '更新公告'}</Text>
    {page === 'about' ? <>
      <Card><Text style={styles.brand}>CetaMesh</Text><InfoText label="作者" value="chx6418-source" /><InfoText label="版本" value={version} /></Card>
      <Card>
        <SettingsRow icon={<RefreshCw size={21} color={colors.accent} />} title="检查更新" subtitle="检查是否有新版本" testID="check-update" onPress={async () => {
          try {const result = await updates.checkForUpdate(); setMessage(result.status === 'available' ? `发现新版本 ${result.version}` : result.status === 'current' ? '当前已是最新版本' : result.status === 'unconfigured' ? '更新服务暂未开放' : '暂未发现可用发布版本');}
          catch {setMessage('检查更新失败，请稍后重试');}
        }} />
        <SettingsRow icon={<Download size={21} color={colors.accent} />} title="应用更新" subtitle="下载并安装最新版本" testID="download-update" onPress={async () => {
          try {const check = await updates.checkForUpdate(); if (check.status === 'unconfigured') {setMessage('更新服务暂未开放'); return;} const result = await updates.downloadUpdate(); if (result) {await Linking.openURL(result); setMessage('已打开 APK 下载地址');} else {setMessage('暂无可下载的 APK 更新包');}}
          catch {setMessage('下载更新失败，请稍后重试');}
        }} />
        <SettingsRow icon={<Bell size={21} color={colors.accent} />} title="更新公告" subtitle="查看版本更新内容与改进" testID="release-notes" onPress={() => {setMessage(''); setPage('announcements');}} />
      </Card>
    </> : <Card>
      <InfoText label="当前版本" value={version} /><InfoText label="最新版本" value={latest ?? '暂不可用'} />
      {notes.length ? notes.map(note => <View key={`${note.version}:${note.publishedAt}`} style={styles.note}><Text style={styles.rowTitle}>{announcementTitle(note)}</Text><Text style={styles.subtle}>{note.publishedAt}</Text><Text style={styles.body}>{note.content}</Text></View>) : <Text style={styles.subtle}>暂无更新公告</Text>}
    </Card>}
    {message ? <Text accessibilityLiveRegion="polite" style={styles.subtle}>{message}</Text> : null}
  </ScrollView>;
}

function announcementTitle(note: UpdateAnnouncement): string {return note.title.includes(note.version) ? note.title : `${note.title} · ${note.version}`;}
function InfoText({label, value}: {label: string; value: string}) {return <View style={styles.infoRow}><Text style={styles.subtle}>{label}</Text><Text style={styles.rowTitle}>{value}</Text></View>;}
function SettingsRow({icon, title, subtitle, onPress, testID}: {icon: React.ReactNode; title: string; subtitle: string; onPress: () => void; testID: string}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} testID={testID} onPress={onPress} style={styles.settingsRow}>
    {icon}<View style={styles.settingsCopy}><Text style={styles.rowTitle}>{title}</Text><Text style={styles.subtle}>{subtitle}</Text></View><ChevronRight size={19} color={colors.textMuted} />
  </Pressable>;
}

const styles = StyleSheet.create({
  page: {padding: space.lg, gap: space.md}, title: {fontSize: 22, fontWeight: '700', color: colors.text}, brand: {fontSize: 19, fontWeight: '700', color: colors.text},
  infoRow: {flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm},
  rowTitle: {fontSize: 15, fontWeight: '600', color: colors.text}, subtle: {fontSize: 13, color: colors.textMuted}, body: {fontSize: 15, lineHeight: 23, color: colors.text}, note: {gap: space.sm, paddingVertical: space.md},
  settingsRow: {minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: space.md}, settingsCopy: {flex: 1, gap: 3},
});
