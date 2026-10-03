import {tr} from '../../shared/i18n';
import React, {useEffect, useRef, useState} from 'react';
import {Alert, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileServices} from '../../runtime/session/MobileServices';
import type {DeviceIdentity} from '../../domain/identity/DeviceIdentity';
import type {DeviceTrust} from '../../domain/device/DeviceTrust';
import type {PairingPreview} from '../../runtime/identity/PairingRuntime';
import {CetaError} from '../../shared/errors/CetaError';
import {ErrorNotice, safeError, ui} from '../../shared/ui/Controls';
import {BottomSheet, Button, Card, EmptyState, LoadingState} from '../../shared/ui/DesignSystem';
import {colors, radii, space} from '../../shared/ui/tokens';

type DeviceDetails = {title: string; deviceId: string; publicKey: string; endpoint?: string; platform?: string};

export function DevicesScreen({services, onBack}: {services: MobileServices; onBack: () => void}) {
  const [identity, setIdentity] = useState<DeviceIdentity>();
  const [trusts, setTrusts] = useState<DeviceTrust[]>([]);
  const [preview, setPreview] = useState<PairingPreview>();
  const [details, setDetails] = useState<DeviceDetails>();
  const [error, setError] = useState<ReturnType<typeof safeError>>();
  const [busy, setBusy] = useState(false);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [trustLoading, setTrustLoading] = useState(true);
  const [trustLoadFailed, setTrustLoadFailed] = useState(false);
  const active = useRef(true);
  const generation = useRef(0);
  const running = useRef(false);
  const pairing = services.pairing;

  useEffect(() => {
    active.current = true;
    const version = generation;
    if (services.identity) {
      services.identity.get()
        .then(value => {if (active.current) {setIdentity(value);}})
        .catch(nextError => {if (active.current) {setError(safeError(nextError));}})
        .finally(() => {if (active.current) {setIdentityLoading(false);}});
    } else {
      setIdentityLoading(false);
    }
    if (pairing) {
      pairing.listTrust()
        .then(value => {if (active.current) {setTrusts(value); setTrustLoadFailed(false);}})
        .catch(nextError => {if (active.current) {setError(safeError(nextError)); setTrustLoadFailed(true);}})
        .finally(() => {if (active.current) {setTrustLoading(false);}});
    } else {
      setTrustLoading(false);
    }
    return () => {
      active.current = false;
      version.current++;
      pairing?.cancel();
      services.qrScanner?.cancel();
    };
  }, [pairing, services]);

  const current = (version: number) => active.current && version === generation.current;
  const run = async (operation: () => Promise<void>) => {
    if (running.current) {return;}
    running.current = true;
    setBusy(true);
    setError(undefined);
    const version = generation.current;
    try {
      await operation();
    } catch (nextError) {
      if (active.current && version === generation.current) {
        setError(safeError(nextError));
        setPreview(undefined);
      }
    } finally {
      running.current = false;
      if (active.current) {setBusy(false);}
    }
  };

  const cancel = () => {
    generation.current++;
    pairing?.cancel();
    services.qrScanner?.cancel();
    setPreview(undefined);
  };

  const showIdentity = (value: DeviceIdentity) => {
    setDetails({title: value.deviceName, deviceId: value.deviceId, publicKey: value.publicKey, platform: value.platform});
  };

  const removeTrust = (trust: DeviceTrust) => {
    Alert.alert('Remove trusted device?', `${trust.deviceName} will need to pair again before connecting.`, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Remove trust',
        style: 'destructive',
        onPress: () => run(async () => {
          const version = generation.current;
          await pairing!.removeTrust(trust.deviceId);
          const list = await pairing!.listTrust();
          if (current(version)) {setTrusts(list);}
        }),
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.page}>
        <Button title={tr('Workspace')} variant="subtle" testID="devices-back" onPress={() => {cancel(); onBack();}} />
        <View style={styles.intro}>
          <Text style={styles.eyebrow}>{tr('CETAMESH DEVICE MESH')}</Text>
          <Text style={ui.title}>{tr('Devices')}</Text>
          <Text style={ui.text}>{tr('This phone works on its own. Pairing adds a trusted connection; Memory stays local until a supported sync is chosen.')}</Text>
        </View>

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>{tr('This phone')}</Text>
          {identity ? <Text style={styles.activeBadge}>{tr('Active')}</Text> : null}
        </View>
        {identityLoading ? (
          <LoadingCard label={tr('Checking this phone’s identity…')} />
        ) : identity ? (
          <Card style={styles.deviceCard}>
            <View style={styles.deviceHeading}>
              <View style={styles.deviceMark}><Text style={styles.deviceMarkText}>C</Text></View>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>{identity.deviceName}</Text>
                <Text style={styles.deviceMeta}>{platformLabel(identity.platform)} · This device</Text>
              </View>
            </View>
            <Text style={styles.deviceId}>Device ID · {identity.deviceId}</Text>
            <Text style={styles.securityNote}>{tr('Private identity keys stay in system secure storage and cannot be exported.')}</Text>
            <Button title={tr('Review device identity')} variant="subtle" testID="mobile-identity-details" onPress={() => showIdentity(identity)} />
          </Card>
        ) : (
          <Card testID="device-identity-unavailable">
            <Text style={styles.sectionTitle}>{tr('Secure identity unavailable')}</Text>
            <Text style={ui.label}>{tr('This device cannot start pairing without a protected device identity.')}</Text>
          </Card>
        )}

        <ErrorNotice error={error} />
        {preview ? (
          <PairingReview
            preview={preview}
            busy={busy}
            onCancel={cancel}
            onExchange={() => run(async () => {
              const version = generation.current;
              const next = await pairing!.exchange(preview.id);
              if (current(version)) {setPreview(next);}
            })}
            onConfirm={() => run(async () => {
              const version = generation.current;
              await pairing!.confirm(preview.id);
              if (current(version)) {setPreview(undefined);}
              // Trust is committed before the list refresh, even if the screen closes.
              const list = await pairing!.listTrust();
              if (active.current) {setTrusts(list);}
            })}
          />
        ) : (
          <Card style={styles.pairCard}>
            <View style={styles.pairCopy}>
              <Text style={styles.sectionTitle}>{tr('Pair a device')}</Text>
              <Text style={ui.label}>{tr('Scan a CetaMesh pairing QR code and verify the device details before confirming trust.')}</Text>
            </View>
            <Button
              title={busy ? 'Opening camera…' : 'Scan pairing code'}
              variant="primary"
              testID="scan-pairing"
              disabled={busy || !identity || !services.qrScanner || !pairing}
              onPress={() => run(async () => {
                if (!pairing || !services.qrScanner) {throw new CetaError('unsupported', 'Pairing is unavailable');}
                const version = generation.current;
                const raw = await services.qrScanner.scan();
                if (current(version)) {setPreview(pairing.preview(raw));}
              })}
            />
          </Card>
        )}

        <View style={styles.sectionHeading}>
          <View style={styles.sectionHeadingCopy}>
            <Text style={styles.sectionTitle}>{tr('Trusted devices')}</Text>
            <Text style={ui.label}>
              {trustLoading
                ? 'Checking trusted devices…'
                : trustLoadFailed
                  ? 'Trusted devices unavailable'
                  : `${trusts.length} trusted ${trusts.length === 1 ? 'device' : 'devices'}`}
            </Text>
          </View>
        </View>
        {trustLoading ? <LoadingCard label={tr('Loading trusted devices…')} /> : null}
        {!trustLoading && !trustLoadFailed && !trusts.length ? (
          <EmptyState
            testID="trusted-devices-empty"
            icon="↔"
            title={tr('No trusted devices yet')}
            description={tr('Pair a Desktop node to add it to your trusted device list.')}
          />
        ) : null}
        {!trustLoading ? trusts.map(trust => (
          <Card key={trust.deviceId} style={styles.deviceCard}>
            <View style={styles.deviceHeading}>
              <View style={styles.deviceMark}><Text style={styles.deviceMarkText}>D</Text></View>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>{trust.deviceName}</Text>
                <Text style={styles.deviceMeta}>{tr('Trusted device')}</Text>
              </View>
              <Text style={styles.trustedBadge}>{tr('Trusted')}</Text>
            </View>
            <Text numberOfLines={1} style={styles.deviceId}>Device ID · {trust.deviceId}</Text>
            <View style={styles.deviceActions}>
              <Button title={tr('Device details')} variant="subtle" testID={`device-details-${trust.deviceId}`} onPress={() => setDetails({title: trust.deviceName, deviceId: trust.deviceId, publicKey: trust.publicKey, endpoint: trust.endpoint})} />
              <Button title={tr('Remove trust')} variant="danger" testID={`remove-trust-${trust.deviceId}`} disabled={busy} onPress={() => removeTrust(trust)} />
            </View>
          </Card>
        )) : null}
      </ScrollView>

      <BottomSheet
        visible={Boolean(details)}
        title={tr('Device identity')}
        onClose={() => setDetails(undefined)}
        testIDPrefix="device-details-sheet">
        {details ? (
          <View style={styles.detailContent}>
            <Text style={styles.detailTitle}>{details.title}</Text>
            {details.platform ? <MetaRow label={tr('Platform')} value={platformLabel(details.platform)} /> : null}
            {details.endpoint ? <MetaRow label={tr('Secure endpoint')} value={details.endpoint} /> : null}
            <MetaRow label={tr('Device ID')} value={details.deviceId} />
            <Text style={styles.publicKeyLabel}>{tr('Public key')}</Text>
            <Text selectable style={styles.publicKey}>{details.publicKey}</Text>
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
}

function PairingReview({
  preview,
  busy,
  onCancel,
  onExchange,
  onConfirm,
}: {
  preview: PairingPreview;
  busy: boolean;
  onCancel: () => void;
  onExchange: () => void;
  onConfirm: () => void;
}) {
  const destination = preview.stage === 'destination';
  return (
    <Card testID="pairing-review" style={styles.reviewCard}>
      <Text style={styles.eyebrow}>{tr('SECURITY REVIEW')}</Text>
      <Text style={styles.sectionTitle}>{destination ? 'Check the pairing destination' : 'Verify this device'}</Text>
      <View style={styles.reviewDetails}>
        <MetaRow label={tr('Device')} value={preview.peer.deviceName} />
        <MetaRow label={tr('Device ID')} value={preview.peer.deviceId} />
        <MetaRow label={tr('HTTPS address')} value={preview.endpoint} />
        <MetaRow label={tr('Invitation expires')} value={formatDate(preview.expiresAt)} />
        <Text style={styles.publicKeyLabel}>{tr('Public key')}</Text>
        <Text selectable style={styles.publicKey}>{preview.peer.publicKey}</Text>
      </View>
      <Text style={styles.securityNote}>
        {destination
          ? 'Confirm only if this HTTPS address came from the device you intend to pair.'
          : 'The peer signature was verified. Compare the device ID and public key on both devices before establishing trust.'}
      </Text>
      <View style={styles.deviceActions}>
        {destination ? (
          <Button title={busy ? 'Connecting…' : 'Continue securely'} variant="primary" testID="pairing-exchange" disabled={busy} onPress={onExchange} />
        ) : (
          <Button title={busy ? 'Saving trust…' : 'Trust this device'} variant="primary" testID="pairing-confirm" disabled={busy} onPress={onConfirm} />
        )}
        <Button title={tr('Cancel pairing')} variant="subtle" testID="pairing-cancel" disabled={busy} onPress={onCancel} />
      </View>
    </Card>
  );
}

function LoadingCard({label}: {label: string}) {
  return (
    <Card style={styles.loadingCard}>
      <LoadingState label={label} />
    </Card>
  );
}

function MetaRow({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text selectable style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function platformLabel(value: string) {
  const labels: Record<string, string> = {android: 'Android', ios: 'iOS'};
  return labels[value.toLowerCase()] ?? value;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? tr('Unknown') : date.toLocaleString();
}

const styles = StyleSheet.create({
  screen: {flex: 1, minHeight: 0},
  page: {padding: space.lg, gap: space.md, paddingBottom: space.xxl},
  intro: {gap: space.sm, paddingVertical: space.xs},
  eyebrow: {fontSize: 11, lineHeight: 15, letterSpacing: 1.1, fontWeight: '700', color: colors.accent},
  sectionHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, marginTop: space.sm},
  sectionHeadingCopy: {gap: space.xs},
  sectionTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  activeBadge: {overflow: 'hidden', borderRadius: radii.pill, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: colors.successSoft, color: colors.success, fontSize: 11, lineHeight: 16, fontWeight: '700'},
  trustedBadge: {overflow: 'hidden', borderRadius: radii.pill, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: colors.accentSoft, color: colors.accent, fontSize: 11, lineHeight: 16, fontWeight: '700'},
  deviceCard: {gap: space.md},
  deviceHeading: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  deviceMark: {width: 38, height: 38, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft},
  deviceMarkText: {fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.accent},
  deviceCopy: {flex: 1, gap: 2},
  deviceName: {fontSize: 15, lineHeight: 21, fontWeight: '700', color: colors.text},
  deviceMeta: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  deviceId: {fontSize: 11, lineHeight: 16, color: colors.textMuted},
  securityNote: {fontSize: 12, lineHeight: 18, color: colors.textMuted},
  pairCard: {gap: space.md, borderColor: colors.accent},
  pairCopy: {gap: space.xs},
  reviewCard: {gap: space.md, borderColor: colors.accent},
  reviewDetails: {padding: space.md, borderRadius: radii.md, backgroundColor: colors.background, gap: space.md},
  deviceActions: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  loadingCard: {minHeight: 88, alignItems: 'center', justifyContent: 'center', gap: space.sm},
  metaRow: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md},
  metaLabel: {fontSize: 12, lineHeight: 17, color: colors.textMuted},
  metaValue: {flexShrink: 1, textAlign: 'right', fontSize: 12, lineHeight: 17, fontWeight: '600', color: colors.text},
  detailContent: {gap: space.md, paddingBottom: space.xl},
  detailTitle: {fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.text},
  publicKeyLabel: {fontSize: 12, lineHeight: 17, fontWeight: '700', color: colors.textMuted},
  publicKey: {fontSize: 11, lineHeight: 16, color: colors.text},
});
