/**
 * InventoryDeviceCard.tsx
 * Shows this tablet as the asset management web app knows it (code, name, assigned user,
 * location) on the PIN screen, above the inventory check-in button.
 */

import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { InventoryDeviceInfo } from '../utils/InventoryCheckInService';

interface InventoryDeviceCardProps {
  info: InventoryDeviceInfo | null;
  loading: boolean;
  /** Message of the last failed refresh; info is then the cached copy, if any */
  error: string | null;
}

/** dd/MM/yyyy HH:mm in the tablet's local time */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const Row: React.FC<{ label: string; value: string; sub?: string | null; muted?: boolean }> = ({
  label,
  value,
  sub,
  muted,
}) => (
  <View style={styles.row}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.valueCol}>
      <Text style={[styles.value, muted && styles.valueMuted]}>{value}</Text>
      {!!sub && <Text style={styles.sub}>{sub}</Text>}
    </View>
  </View>
);

const InventoryDeviceCard: React.FC<InventoryDeviceCardProps> = ({ info, loading, error }) => {
  const { t } = useTranslation();

  if (!info) {
    return (
      <View style={styles.card}>
        {loading ? (
          <View style={styles.footerRow}>
            <ActivityIndicator size="small" color="#1976D2" />
            <Text style={styles.footerText}>{t('screens.pin.deviceInfo.loading')}</Text>
          </View>
        ) : (
          <Text style={styles.errorText}>{error || t('screens.pin.deviceInfo.unavailable')}</Text>
        )}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('screens.pin.deviceInfo.title')}</Text>
        {!!info.statusLabel && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{info.statusLabel}</Text>
          </View>
        )}
      </View>

      <Row label={t('screens.pin.deviceInfo.code')} value={info.assetCode} />
      <Row label={t('screens.pin.deviceInfo.name')} value={info.assetName} />
      <Row
        label={t('screens.pin.deviceInfo.assignee')}
        value={info.assigneeName || t('screens.pin.deviceInfo.notAssigned')}
        sub={info.assigneeName ? info.assigneeDepartment : null}
        muted={!info.assigneeName}
      />
      <Row
        label={t('screens.pin.deviceInfo.location')}
        value={info.locationPath || t('screens.pin.deviceInfo.noLocation')}
        muted={!info.locationPath}
      />

      <View style={styles.footerRow}>
        {loading && <ActivityIndicator size="small" color="#1976D2" />}
        <Text style={[styles.footerText, !!error && !loading && styles.footerError]}>
          {loading
            ? t('screens.pin.deviceInfo.refreshing')
            : error
              ? t('screens.pin.deviceInfo.stale', { time: formatDateTime(info.fetchedAt), error })
              : t('screens.pin.deviceInfo.updatedAt', { time: formatDateTime(info.fetchedAt) })}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  badge: {
    backgroundColor: '#E3F2FD',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeText: {
    color: '#1565C0',
    fontSize: 13,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 4,
  },
  label: {
    width: 140,
    color: '#777',
    fontSize: 15,
  },
  valueCol: {
    flex: 1,
  },
  value: {
    color: '#222',
    fontSize: 15,
    fontWeight: '600',
  },
  valueMuted: {
    color: '#999',
    fontStyle: 'italic',
    fontWeight: '400',
  },
  sub: {
    color: '#666',
    fontSize: 13,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 8,
  },
  footerText: {
    color: '#999',
    fontSize: 12,
    flexShrink: 1,
  },
  footerError: {
    color: '#C62828',
  },
  errorText: {
    color: '#C62828',
    fontSize: 14,
    textAlign: 'center',
  },
});

export default InventoryDeviceCard;
