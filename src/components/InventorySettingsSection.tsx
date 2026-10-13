/**
 * InventorySettingsSection.tsx
 * Settings for the inventory self check-in: server URL, API key and this tablet's asset code
 * (typed or scanned from the asset QR sticker), with a "Test connection" button.
 */

import React, { useEffect, useState } from 'react';
import { Text, StyleSheet, View } from 'react-native';
import SettingsSection from './settings/SettingsSection';
import SettingsInput from './settings/SettingsInput';
import SettingsButton from './settings/SettingsButton';
import SettingsInfoBox from './settings/SettingsInfoBox';
import QrScannerModal from './QrScannerModal';
import FilePickerModule from '../utils/FilePickerModule';
import {
  getInventoryConfig,
  saveInventoryConfig,
  verifyInventoryConfig,
  InventoryOutcome,
} from '../utils/InventoryCheckInService';
import { Colors, Spacing, Typography } from '../theme';
import { useTranslation } from 'react-i18next';

export const InventorySettingsSection: React.FC = () => {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [assetCode, setAssetCode] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<InventoryOutcome | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    getInventoryConfig().then(config => {
      setBaseUrl(config.baseUrl);
      setApiKey(config.apiKey);
      setAssetCode(config.assetCode);
      setLoaded(true);
    });
  }, []);

  // Persist on every change once loaded, like the other settings sections.
  useEffect(() => {
    if (loaded) {
      saveInventoryConfig({ baseUrl, apiKey, assetCode });
      setTestResult(null);
    }
  }, [loaded, baseUrl, apiKey, assetCode]);

  const handleScanned = (value: string) => {
    setShowScanner(false);
    // The sticker QR holds the plain asset code (e.g. TAB-0123).
    setAssetCode(value.trim());
  };

  // Read the asset QR from a photo/screenshot instead of the live camera.
  const handlePickImage = async () => {
    setImageError(null);
    let picked: { path: string } | null = null;
    try {
      picked = await FilePickerModule.pickMedia('image');
    } catch (error: any) {
      if (error?.code !== 'PICKER_CANCELLED') {
        setImageError(t('advanced.inventory.imageOpenFailed'));
      }
      return;
    }
    setDecoding(true);
    try {
      const value = await FilePickerModule.decodeQrFromImage(picked.path);
      if (value && value.trim()) {
        setAssetCode(value.trim());
      } else {
        setImageError(t('advanced.inventory.imageNoQr'));
      }
    } catch {
      setImageError(t('advanced.inventory.imageOpenFailed'));
    } finally {
      setDecoding(false);
      // pickMedia copies the image into the app's media folder; it is not needed any more
      FilePickerModule.deleteMediaFile(picked.path).catch(() => {});
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await saveInventoryConfig({ baseUrl, apiKey, assetCode });
      setTestResult(await verifyInventoryConfig({ baseUrl, apiKey, assetCode }));
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsSection title={t('advanced.inventory.title')} icon="clipboard-check-outline">
      <SettingsInfoBox variant="info" title={t('advanced.inventory.infoTitle')}>
        <Text style={styles.infoText}>{t('advanced.inventory.info')}</Text>
      </SettingsInfoBox>

      <SettingsInput
        label={t('advanced.inventory.baseUrl')}
        icon="server"
        placeholder="https://assets.example.com"
        value={baseUrl}
        onChangeText={setBaseUrl}
        keyboardType="url"
        hint={t('advanced.inventory.baseUrlHint')}
      />
      <SettingsInput
        label={t('advanced.inventory.apiKey')}
        icon="key-variant"
        placeholder="kci_..."
        value={apiKey}
        onChangeText={setApiKey}
        secureTextEntry
      />
      <SettingsInput
        label={t('advanced.inventory.assetCode')}
        icon="barcode"
        placeholder="TAB-0123"
        value={assetCode}
        onChangeText={setAssetCode}
        autoCapitalize="characters"
        hint={t('advanced.inventory.assetCodeHint')}
      />
      <View style={styles.buttonRow}>
        <SettingsButton
          title={t('advanced.inventory.scanQr')}
          icon="camera"
          variant="secondary"
          onPress={() => setShowScanner(true)}
          fullWidth={false}
          style={styles.rowButton}
        />
        <SettingsButton
          title={decoding ? t('advanced.inventory.imageReading') : t('advanced.inventory.uploadQrImage')}
          icon="image-outline"
          variant="secondary"
          onPress={handlePickImage}
          disabled={decoding}
          loading={decoding}
          fullWidth={false}
          style={styles.rowButton}
        />
      </View>
      {!!imageError && (
        <SettingsInfoBox variant="error" title={t('advanced.inventory.imageErrorTitle')}>
          <Text style={styles.infoText}>{imageError}</Text>
        </SettingsInfoBox>
      )}
      <SettingsButton
        title={testing ? t('advanced.inventory.testing') : t('advanced.inventory.test')}
        icon="lan-connect"
        variant="primary"
        onPress={handleTest}
        disabled={testing}
        loading={testing}
      />

      {testResult && (
        <SettingsInfoBox
          variant={testResult.kind === 'success' ? 'success' : 'error'}
          title={testResult.kind === 'success' ? t('advanced.inventory.testOk') : t('advanced.inventory.testFailed')}
        >
          <Text style={styles.infoText}>{testResult.message}</Text>
        </SettingsInfoBox>
      )}

      <QrScannerModal
        visible={showScanner}
        onClose={() => setShowScanner(false)}
        onScanned={handleScanned}
      />
    </SettingsSection>
  );
};

const styles = StyleSheet.create({
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  rowButton: {
    flex: 1,
  },
  infoText: {
    ...Typography.body,
    color: Colors.textSecondary,
    marginBottom: Spacing.xs,
  },
});

export default InventorySettingsSection;
