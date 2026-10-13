import React, { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, NativeModules, BackHandler, ActivityIndicator } from 'react-native';
import PinInput from '../components/PinInput';
import { StorageService } from '../utils/storage';
import { migrateOldPin, hasSecurePin } from '../utils/secureStorage';
import AppLauncherModule from '../utils/AppLauncherModule';
import { grantSettingsAccess } from '../utils/authState';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { useTranslation } from 'react-i18next';
import {
  getInventoryConfig,
  getCachedDeviceInfo,
  isInventoryConfigured,
  performInventoryCheckIn,
  refreshDeviceInfo,
  InventoryDeviceInfo,
  InventoryOutcome,
} from '../utils/InventoryCheckInService';
import InventoryDeviceCard from '../components/InventoryDeviceCard';

type PinScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Pin'>;

interface PinScreenProps {
  navigation: PinScreenNavigationProp;
  route?: { params?: { initialTab?: string } };
}

const PinScreen: React.FC<PinScreenProps> = ({ navigation, route }) => {
  const initialTab = route?.params?.initialTab;
  const { t } = useTranslation();
  const [storedPin, setStoredPin] = useState<string>('1234');
  const [migrationDone, setMigrationDone] = useState<boolean>(false);
  const [displayMode, setDisplayMode] = useState<'webview' | 'external_app' | 'media_player'>('webview');
  const [externalAppPackage, setExternalAppPackage] = useState<string | null>(null);
  // Inventory self check-in: available before the PIN is entered, it only reports presence.
  const [inventoryEnabled, setInventoryEnabled] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkInResult, setCheckInResult] = useState<InventoryOutcome | null>(null);
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Device card: cached copy shown at once, refreshed from the web app on every focus.
  const [deviceInfo, setDeviceInfo] = useState<InventoryDeviceInfo | null>(null);
  const [deviceInfoLoading, setDeviceInfoLoading] = useState(false);
  const [deviceInfoError, setDeviceInfoError] = useState<string | null>(null);

  useEffect(() => {
    migrateFromOldSystem();
    loadDisplayMode();
  }, []);

  // Re-read on focus: the inventory settings may have just been changed in Settings.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const config = await getInventoryConfig();
        const configured = isInventoryConfigured(config);
        if (cancelled) {
          return;
        }
        setInventoryEnabled(configured);
        if (!configured) {
          setDeviceInfo(null);
          return;
        }
        const cached = await getCachedDeviceInfo(config);
        if (cancelled) {
          return;
        }
        setDeviceInfo(cached);
        setDeviceInfoError(null);
        setDeviceInfoLoading(true);
        const refreshed = await refreshDeviceInfo(config);
        if (cancelled) {
          return;
        }
        setDeviceInfo(refreshed.info);
        setDeviceInfoError(refreshed.error ? refreshed.error.message : null);
      } catch {
        if (!cancelled) {
          setInventoryEnabled(false);
        }
      } finally {
        if (!cancelled) {
          setDeviceInfoLoading(false);
        }
      }
    };
    load();
    const unsubscribe = navigation.addListener('focus', load);
    return () => {
      cancelled = true;
      unsubscribe();
      if (resultTimerRef.current) {
        clearTimeout(resultTimerRef.current);
      }
    };
  }, [navigation]);

  const handleInventoryCheckIn = async (): Promise<void> => {
    if (checkingIn) {
      return;
    }
    if (resultTimerRef.current) {
      clearTimeout(resultTimerRef.current);
    }
    setCheckingIn(true);
    setCheckInResult(null);
    try {
      const outcome = await performInventoryCheckIn();
      setCheckInResult(outcome);
      if (outcome.deviceInfo) {
        setDeviceInfo(outcome.deviceInfo);
        setDeviceInfoError(null);
      }
      resultTimerRef.current = setTimeout(() => setCheckInResult(null), 15000);
    } finally {
      setCheckingIn(false);
    }
  };

  // Block Android back gesture/button on PIN screen to prevent bypassing PIN (#93)
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // Navigate back to Kiosk instead of allowing default back behavior
      navigation.navigate('Kiosk');
      return true;
    });
    return () => backHandler.remove();
  }, [navigation]);

  const loadDisplayMode = async (): Promise<void> => {
    try {
      const savedDisplayMode = await StorageService.getDisplayMode();
      const savedExternalAppPackage = await StorageService.getExternalAppPackage();
      setDisplayMode(savedDisplayMode);
      setExternalAppPackage(savedExternalAppPackage);
    } catch (error) {
      console.error('[PinScreen] Failed to load display mode:', error);
    }
  };

  const migrateFromOldSystem = async (): Promise<void> => {
    try {
      // Check if already using secure storage
      const hasSecure = await hasSecurePin();

      if (!hasSecure) {
        // Migrate from old plaintext storage
        const oldPin = await StorageService.getPin();
        await migrateOldPin(oldPin);

        // Clear old PIN from AsyncStorage for security
        if (oldPin && oldPin !== '1234') {
          await StorageService.savePin(''); // Clear old plaintext PIN
        }
      }

      setMigrationDone(true);
    } catch (error) {
      console.error('[PinScreen] Migration error:', error);
      setMigrationDone(true); // Continue anyway
    }
  };

  const handleSuccess = (): void => {
    grantSettingsAccess();
    navigation.navigate('Settings', initialTab ? { initialTab } : undefined);
  };

  const handleBack = async (): Promise<void> => {
    // If in external app mode, relaunch the external app with overlay service
    if (displayMode === 'external_app' && externalAppPackage) {
      try {
        // Load return settings
        const returnTapCount = await StorageService.getReturnTapCount();
        const returnTapTimeout = await StorageService.getReturnTapTimeout();
        const returnMode = await StorageService.getReturnMode();
        const returnButtonPosition = await StorageService.getReturnButtonPosition();
        const autoRelaunch = await StorageService.getAutoRelaunchApp();
        
        // Start OverlayService BEFORE launching the external app
        const { OverlayServiceModule } = NativeModules;
        const nfcEnabled = await StorageService.getAllowNotifications();
        await OverlayServiceModule.startOverlayService(
          returnTapCount, 
          returnTapTimeout, 
          returnMode, 
          returnButtonPosition,
          externalAppPackage,
          autoRelaunch,
          nfcEnabled
        );
        console.log('[PinScreen] OverlayService started with auto-relaunch monitoring');
        
        await AppLauncherModule.launchExternalApp(externalAppPackage);
      } catch (error) {
        console.error('[PinScreen] Failed to relaunch external app:', error);
      }
    }
    // Navigate back to Kiosk screen
    navigation.navigate('Kiosk');
  };

  // Wait for migration before showing PIN input
  if (!migrationDone) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.backButton} onPress={handleBack}>
        <Text style={styles.backButtonText}>{t('general.backToKiosk')}</Text>
      </TouchableOpacity>

      <PinInput onSuccess={handleSuccess} storedPin={storedPin} />

      {inventoryEnabled && (
        <View style={styles.inventoryContainer}>
          <InventoryDeviceCard info={deviceInfo} loading={deviceInfoLoading} error={deviceInfoError} />
          {checkInResult && (
            <View
              style={[
                styles.inventoryResult,
                checkInResult.kind === 'success' && styles.inventoryResultSuccess,
                checkInResult.kind === 'warning' && styles.inventoryResultWarning,
                checkInResult.kind === 'error' && styles.inventoryResultError,
              ]}
            >
              <Text style={styles.inventoryResultText}>{checkInResult.message}</Text>
              {!!checkInResult.session && (
                <Text style={styles.inventoryResultSubText}>{checkInResult.session}</Text>
              )}
            </View>
          )}
          <TouchableOpacity
            style={[styles.inventoryButton, checkingIn && styles.inventoryButtonDisabled]}
            onPress={handleInventoryCheckIn}
            disabled={checkingIn}
          >
            {checkingIn && <ActivityIndicator color="#fff" style={styles.inventorySpinner} />}
            <Text style={styles.inventoryButtonText}>
              {checkingIn ? t('screens.pin.inventoryCheckingIn') : t('screens.pin.inventoryCheckIn')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
  backButton: {
    position: 'absolute',
    top: 40,
    left: 20,
    right: 20,
    backgroundColor: '#fff',
    paddingVertical: 15,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#ddd',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    zIndex: 1000,
  },
  backButtonText: {
    color: '#666',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  // In the normal flow below PinInput (flex: 1), so the card never covers the PIN pad.
  inventoryContainer: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 30,
  },
  inventoryButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1976D2',
    paddingVertical: 15,
    borderRadius: 10,
    elevation: 3,
  },
  inventoryButtonDisabled: {
    opacity: 0.7,
  },
  inventorySpinner: {
    marginRight: 10,
  },
  inventoryButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  inventoryResult: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    marginBottom: 10,
  },
  inventoryResultSuccess: {
    backgroundColor: '#2E7D32',
  },
  inventoryResultWarning: {
    backgroundColor: '#F9A825',
  },
  inventoryResultError: {
    backgroundColor: '#C62828',
  },
  inventoryResultText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  inventoryResultSubText: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
  },
});

export default PinScreen;
