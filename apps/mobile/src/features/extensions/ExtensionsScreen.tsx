import {tr} from '../../shared/i18n';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Alert, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {ExtensionImportCandidate} from '../../runtime/extension/ExtensionImportRuntime';
import type {InstalledExtension} from '../../domain/extension/ExtensionRepository';
import type {MobileServices} from '../../runtime/session/MobileServices';
import {CetaError} from '../../shared/errors/CetaError';
import {ErrorNotice, safeError, ui} from '../../shared/ui/Controls';
import {BottomSheet, Button, Card, EmptyState, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';
import {permissionRisk} from '../../runtime/extension/ExtensionInstallRuntime';
import {mapExtensionPermissions} from '../../runtime/extension/ExtensionValidationRuntime';

export function ExtensionsScreen({services, onBack}: {services: MobileServices; onBack: () => void}) {
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [candidate, setCandidate] = useState<ExtensionImportCandidate>();
  const [details, setDetails] = useState<InstalledExtension>();
  const [showImportDetails, setShowImportDetails] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof safeError>>();
  const active = useRef(true);
  const running = useRef(false);
  const lifecycle = services.extensionLifecycle;

  const reload = useCallback(async () => {
    if (!lifecycle) {throw new CetaError('unsupported', 'Extension management is unavailable');}
    const next = await lifecycle.list();
    if (active.current) {setExtensions(next);}
  }, [lifecycle]);

  useEffect(() => {
    active.current = true;
    reload().catch(nextError => {if (active.current) {setError(safeError(nextError));}})
      .finally(() => {if (active.current) {setLoading(false);}});
    return () => {active.current = false;};
  }, [reload]);

  const run = async (operation: () => Promise<void>) => {
    if (running.current) {return;}
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await reload();
    } catch (nextError) {
      if (active.current && !(nextError instanceof CetaError && nextError.code === 'cancelled')) {
        setError(safeError(nextError));
      }
    } finally {
      running.current = false;
      if (active.current) {setBusy(false);}
    }
  };

  const importPackage = async () => {
    if (!services.extensionImport) {
      setError(new CetaError('unsupported', 'Extension import is unavailable on this device'));
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const next = await services.extensionImport.prepareImport();
      if (active.current) {setCandidate(next); setShowImportDetails(false);}
    } catch (nextError) {
      if (active.current && !(nextError instanceof CetaError && nextError.code === 'cancelled')) {
        setError(safeError(nextError));
      }
    } finally {
      if (active.current) {setBusy(false);}
    }
  };

  const confirmImport = async () => {
    if (!candidate || !services.extensionImport) {return;}
    await run(async () => {
      await services.extensionImport!.install(candidate, candidate.requiresPermissionConfirmation || permissionRisk(mapExtensionPermissions(candidate.manifest.permissions), candidate.manifest.networkAccess.mode) === 'high');
      setCandidate(undefined);
    });
  };

  const remove = (extension: InstalledExtension) => {
    Alert.alert(tr('Remove imported extension?'), `${extension.manifest.name} and its saved manifest will be removed from this device.`, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: tr('Remove extension'),
        style: 'destructive',
        onPress: () => run(async () => {
          if (!lifecycle) {throw new CetaError('unsupported', 'Extension management is unavailable');}
          await lifecycle.remove(extension.id, extension.source);
          setDetails(undefined);
        }),
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      {candidate ? (
        <ScrollView contentContainerStyle={styles.page}>
          <Button title={tr('Extensions')} variant="subtle" testID="extension-import-back" disabled={busy} onPress={() => setCandidate(undefined)} />
          <View style={styles.intro}>
            <Text style={ui.title}>{candidate.existingVersion ? '确认更新插件' : '确认安装插件'}</Text>
          </View>
          <Card style={styles.reviewCard}>
            <Text style={styles.extensionName}>{candidate.manifest.name}</Text>
            <Text style={styles.extensionMeta}>版本 {candidate.manifest.version}</Text>
            {candidate.manifest.publisher ? <Text style={ui.label}>发布者：{candidate.manifest.publisher}</Text> : null}
            <Text style={ui.text}>{purposeLabel(candidate.manifest.type)}安装后默认停用。</Text>
            <View style={styles.reviewDivider} />
            <Text style={styles.detailLabel}>需要访问</Text>
            {candidate.manifest.permissions.length ? candidate.manifest.permissions.map(permission => (
              <Text key={permissionKey(permission)} style={styles.permissionText}>• {permissionName(permission.capability)}</Text>
            )) : <Text style={ui.label}>• 无额外权限</Text>}
            {candidate.manifest.networkAccess.mode !== 'none' ? <Text style={styles.permissionText}>• 网络</Text> : null}
            <Text style={styles.reviewNote}>
              {permissionRisk(mapExtensionPermissions(candidate.manifest.permissions), candidate.manifest.networkAccess.mode) === 'high' || candidate.requiresPermissionConfirmation
                ? '安全检查：涉及敏感权限，需要额外确认。'
                : '安全检查：未发现高风险权限。'}
            </Text>
            <Button title={showImportDetails ? '收起详细信息' : '查看详细信息'} variant="subtle" testID="extension-import-details" onPress={() => setShowImportDetails(value => !value)} />
            {showImportDetails ? <View style={styles.detailContent}>
              <InfoRow label="文件" value={candidate.fileName} />
              <InfoRow label="插件 ID" value={candidate.manifest.id} />
              <InfoRow label="类型" value={typeLabel(candidate.manifest.type)} />
              <InfoRow label="网络访问" value={candidate.manifest.networkAccess.mode} />
              <InfoRow label="平台" value={candidate.manifest.platforms.join(', ')} />
              <Text style={styles.detailLabel}>权限详情</Text>
              {candidate.manifest.permissions.map(permission => <PermissionRow key={permissionKey(permission)} permission={permission} />)}
            </View> : null}
          </Card>
          <ErrorNotice error={error} />
          <View style={styles.actions}>
            <Button
              title={busy ? '正在安装…' : confirmTitle(candidate)}
              variant="primary"
              testID="extension-import-confirm"
              disabled={busy}
              onPress={confirmImport}
            />
            <Button title={tr('Cancel')} variant="subtle" testID="extension-import-cancel" disabled={busy} onPress={() => setCandidate(undefined)} />
          </View>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.page}>
          <Button title={tr('Workspace')} variant="subtle" testID="extensions-back" onPress={onBack} />
          <View style={styles.intro}><Text style={ui.title}>插件与工具</Text></View>
          <Card style={styles.importCard}>
            <View style={styles.importCopy}>
              <Text style={styles.sectionTitle}>导入插件</Text>
              <Text style={ui.label}>选择插件文件并确认安装。</Text>
            </View>
            <Button title={busy ? '正在打开文件…' : '选择文件'} variant="secondary" testID="extension-import" disabled={busy || !services.extensionImport} onPress={importPackage} />
          </Card>
          <View style={styles.sectionHeading}>
            <View style={styles.sectionCopy}>
              <Text style={styles.sectionTitle}>{tr('Installed')}</Text>
              <Text style={ui.label}>
                {loading
                  ? '正在检查插件…'
                  : error
                    ? '无法加载插件列表'
                    : `共 ${extensions.length} 个插件`}
              </Text>
            </View>
          </View>
          {loading ? (
            <Card style={styles.loadingCard}><LoadingState label={tr('Loading extensions…')} /></Card>
          ) : null}
          {!loading && !error && extensions.length === 0 ? (
            <EmptyState
              testID="extensions-empty"
              icon="+"
              title={tr('No extensions yet')}
              description="导入插件后会显示在这里。"
            />
          ) : null}
          {!loading ? extensions.map(extension => (
            <ExtensionCard
              key={`${extension.id}:${extension.source}`}
              extension={extension}
              onDetails={() => setDetails(extension)}

            />
          )) : null}
          <ErrorNotice error={error} />
        </ScrollView>
      )}

      <BottomSheet visible={Boolean(details)} title="权限详情" onClose={() => setDetails(undefined)} testIDPrefix="extension-details-sheet">
        {details ? <ExtensionDetails extension={details} busy={busy}
          onEnable={() => run(async () => {await lifecycle!.enable(details.id, details.source); setDetails(undefined);})}
          onDisable={() => run(async () => {await lifecycle!.disable(details.id, details.source); setDetails(undefined);})}
          onRollback={() => run(async () => {await lifecycle!.rollback(details.id, details.source); setDetails(undefined);})}
          onRemove={() => remove(details)} /> : null}
      </BottomSheet>
    </View>
  );
}

function ExtensionCard({extension, onDetails}: {
  extension: InstalledExtension; onDetails: () => void;
}) {
  const key = `${extension.id}-${extension.source}`;
  return (
    <Card style={styles.extensionCard} testID={`extension-card-${key}`}>
      <View style={styles.extensionHeader}>
        <View style={styles.extensionCopy}>
          <Text style={styles.extensionName}>{extension.manifest.name}</Text>
          <Text numberOfLines={1} style={styles.extensionMeta}>{extension.manifest.publisher} · v{extension.manifest.version}</Text>
        </View>
        <Text style={[styles.statusBadge, extension.status === 'enabled' && styles.enabledBadge]}>{statusLabel(extension.status)}</Text>
      </View>
      <Button title="查看详情 ›" variant="subtle" testID={`extension-details-${key}`} onPress={onDetails} />
    </Card>
  );
}

function ExtensionDetails({extension, busy, onEnable, onDisable, onRollback, onRemove}: {
  extension: InstalledExtension; busy: boolean; onEnable: () => void; onDisable: () => void;
  onRollback: () => void; onRemove: () => void;
}) {
  const report = extension.securityReport;
  return (
    <View style={styles.detailContent}>
      <Text style={styles.extensionName}>{extension.manifest.name}</Text>
      <InfoRow label={tr('Publisher')} value={report.publisher} />
      <InfoRow label={tr('Signature')} value={signatureLabel(report.signatureState)} />
      <InfoRow label={tr('Status')} value={statusLabel(extension.status)} />
      <InfoRow label={tr('Source')} value={sourceLabel(extension.source)} />
      <InfoRow label={tr('Risk')} value={`${riskLabel(report.risk)} · ${networkLabel(report.networkAccess)}`} />
      <InfoRow label={tr('Platforms')} value={report.platforms.join(', ')} />
      <InfoRow label={tr('Data scope')} value={report.dataScope.join(', ') || tr('None declared')} />
      <Text style={styles.detailLabel}>{tr('Permissions')}</Text>
      {report.permissions.length ? report.permissions.map(permission => (
        <PermissionRow key={permissionKey(permission)} permission={permission} />
      )) : <Text style={ui.label}>{tr('No permissions requested.')}</Text>}
      {report.addedPermissions.length ? (
        <>
          <Text style={styles.detailLabel}>{tr('Permissions added in the latest update')}</Text>
          {report.addedPermissions.map(permission => <PermissionRow key={permissionKey(permission)} permission={permission} emphasis />)}
        </>
      ) : null}
      <InfoRow label={tr('Updated')} value={new Date(extension.updatedAt).toLocaleString()} />
      <Text style={styles.hashLabel}>{tr('Content fingerprint')}</Text>
      <Text selectable style={styles.hash}>{report.contentHash}</Text>
      <View style={styles.actions}>
        <Button title={extension.status === 'enabled' ? '停用' : '启用'} testID={`extension-${extension.status === 'enabled' ? 'disable' : 'enable'}-${extension.id}-${extension.source}`} disabled={busy} onPress={extension.status === 'enabled' ? onDisable : onEnable} />
        {extension.previousManifest ? <Button title="回滚" testID={`extension-rollback-${extension.id}-${extension.source}`} disabled={busy} onPress={onRollback} /> : null}
        {extension.source !== 'base' ? <Button title="移除" variant="danger" testID={`extension-remove-${extension.id}-${extension.source}`} disabled={busy} onPress={onRemove} /> : null}
      </View>
    </View>
  );
}

function PermissionRow({permission, emphasis = false}: {permission: {capability: string; scope: {kind: string; id?: string}}; emphasis?: boolean}) {
  return <Text style={[styles.permissionText, emphasis && styles.permissionAdded]}>{permission.capability} · {permission.scope.kind}{permission.scope.id ? `:${permission.scope.id}` : ''}</Text>;
}

function InfoRow({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text selectable style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function confirmTitle(candidate: ExtensionImportCandidate) {
  const sensitive = permissionRisk(mapExtensionPermissions(candidate.manifest.permissions), candidate.manifest.networkAccess.mode) === 'high' || candidate.requiresPermissionConfirmation;
  if (sensitive) {return candidate.existingVersion ? '允许并更新' : '允许并安装';}
  return candidate.existingVersion ? '更新插件' : '安装';
}

function purposeLabel(type: InstalledExtension['manifest']['type']) {
  const purpose: Record<InstalledExtension['manifest']['type'], string> = {
    'declarative-tool': '为 CetaMesh 添加可调用的工具。',
    'memory-pack': '为 CetaMesh 添加记忆内容。',
    'remote-plugin': '连接远程插件服务。',
    workflow: '添加可执行的工作流程。',
    'ui-extension': '添加界面功能。',
  };
  return purpose[type];
}

function permissionName(capability: string) {
  if (capability.startsWith('camera.')) {return '相机';}
  if (capability.startsWith('microphone.')) {return '麦克风';}
  if (capability.startsWith('location.')) {return '位置';}
  if (capability.startsWith('network.')) {return '网络';}
  if (capability.startsWith('memory.')) {return '记忆';}
  return '工具权限';
}

function permissionKey(permission: {capability: string; scope: {kind: string; id?: string}}) {
  return `${permission.capability}:${permission.scope.kind}:${permission.scope.id ?? ''}`;
}

function statusLabel(value: InstalledExtension['status']) {
  return value === 'enabled' ? '已启用' : value === 'disabled' ? '已停用' : '已安装';
}

function signatureLabel(value: InstalledExtension['securityReport']['signatureState']) {
  return value === 'verified' ? tr('Verified') : value === 'invalid' ? tr('Invalid') : value === 'unsigned' ? tr('Unsigned') : tr('Unknown');
}

function riskLabel(value: InstalledExtension['securityReport']['risk']) {
  return ({low: tr('Low'), medium: tr('Medium'), high: tr('High'), critical: tr('Critical')} as Record<string, string>)[value] ?? tr('Unknown');
}

function networkLabel(value: InstalledExtension['securityReport']['networkAccess']) {
  return value === 'none' ? '无网络访问' : value === 'remote-declared' ? '连接远程服务' : '按声明访问网络';
}

function sourceLabel(value: InstalledExtension['source']) {
  return value === 'base' ? tr('Built-in') : value === 'user-overlay' ? tr('Personal overlay') : tr('Imported');
}

function typeLabel(value: InstalledExtension['manifest']['type']) {
  const labels: Record<InstalledExtension['manifest']['type'], string> = {
    'declarative-tool': tr('Tool'),
    'memory-pack': tr('Memory pack'),
    'remote-plugin': tr('Remote plugin'),
    workflow: tr('Workflow'),
    'ui-extension': tr('UI extension'),
  };
  return labels[value];
}

const styles = StyleSheet.create({
  screen: {flex: 1, minHeight: 0},
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  intro: {gap: space.sm, paddingVertical: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  sectionHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, marginTop: space.sm},
  sectionCopy: {gap: space.xs},
  sectionTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  importCard: {gap: space.md, borderColor: colors.accentSoft},
  importCopy: {gap: space.xs},
  loadingCard: {minHeight: 84, alignItems: 'center', justifyContent: 'center', gap: space.sm},
  extensionCard: {gap: space.md},
  extensionHeader: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md},
  extensionCopy: {flex: 1, gap: space.xs},
  extensionName: {fontSize: 15, lineHeight: 21, fontWeight: '700', color: colors.text},
  extensionMeta: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  statusBadge: {overflow: 'hidden', borderRadius: radii.pill, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: colors.surfaceMuted, color: colors.textMuted, fontSize: 11, lineHeight: 16, fontWeight: '700'},
  enabledBadge: {backgroundColor: colors.successSoft, color: colors.success},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  reviewCard: {gap: space.md, borderColor: colors.accent},
  reviewHeader: {flexDirection: 'row', alignItems: 'flex-start', gap: space.md},
  unsignedBadge: {overflow: 'hidden', borderRadius: radii.pill, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: colors.dangerSoft, color: colors.danger, fontSize: 11, lineHeight: 16, fontWeight: '700'},
  infoRow: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md},
  infoLabel: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  infoValue: {flexShrink: 1, textAlign: 'right', fontSize: 12, lineHeight: 17, fontWeight: '600', color: colors.text},
  reviewDivider: {height: StyleSheet.hairlineWidth, backgroundColor: colors.border},
  detailLabel: {fontSize: 13, lineHeight: 18, fontWeight: '700', color: colors.text},
  permissionText: {fontSize: 12, lineHeight: 18, color: colors.textMuted},
  permissionAdded: {fontWeight: '700', color: colors.danger},
  reviewNote: {fontSize: 12, lineHeight: 18, color: colors.textMuted},
  detailContent: {gap: space.md, paddingBottom: space.xl},
  hashLabel: {fontSize: 11, lineHeight: 15, fontWeight: '700', color: colors.textMuted},
  hash: {fontSize: 11, lineHeight: 16, color: colors.text},
});
