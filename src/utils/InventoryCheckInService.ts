/**
 * Inventory self check-in.
 * The tablet reports itself as "present" to the asset management web app, the same thing
 * a staff member does by scanning the tablet's asset QR sticker in the web scanner.
 * API: POST /api/inventory/check-in, GET /api/inventory/check-in/verify and
 * GET /api/inventory/device-info (Bearer key). device-info feeds the asset / assignee /
 * location card on the PIN screen; the last answer is cached so the card shows offline too.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { KEYS, StorageService } from './storage';
import { getSecureInventoryKey, saveSecureInventoryKey } from './secureStorage';
import UpdateModule from './UpdateModule';

const REQUEST_TIMEOUT_MS = 15000;
// Network errors and 5xx are retried with the same request_id; the server deduplicates.
const RETRY_DELAYS_MS = [2000, 5000];

export interface InventoryConfig {
  baseUrl: string;
  apiKey: string;
  assetCode: string;
}

export type InventoryOutcomeKind = 'success' | 'warning' | 'error';

export interface InventoryOutcome {
  kind: InventoryOutcomeKind;
  message: string;
  /** Server "result" for check-in, or "error" code on failure */
  code?: string;
  assetName?: string;
  session?: string | null;
  /** Fresh device info returned along with a successful verify / check-in */
  deviceInfo?: InventoryDeviceInfo | null;
}

/** Asset, assignee and location as the web app knows them, for the PIN screen card. */
export interface InventoryDeviceInfo {
  assetCode: string;
  assetName: string;
  statusLabel: string | null;
  category: string | null;
  model: string | null;
  assigneeName: string | null;
  assigneeDepartment: string | null;
  assignedAt: string | null;
  locationName: string | null;
  locationPath: string | null;
  /** When the tablet received this data (ISO) */
  fetchedAt: string;
}

interface CachedDeviceInfo {
  baseUrl: string;
  assetCode: string;
  info: InventoryDeviceInfo;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function parseDeviceInfo(body: any): InventoryDeviceInfo | null {
  const asset = body?.asset;
  if (!asset || typeof asset !== 'object' || !str(asset.code)) {
    return null;
  }
  const assignee = body.assignee && typeof body.assignee === 'object' ? body.assignee : null;
  const location = body.location && typeof body.location === 'object' ? body.location : null;
  return {
    assetCode: str(asset.code) as string,
    assetName: str(asset.name) || (str(asset.code) as string),
    statusLabel: str(asset.status_label),
    category: str(asset.category),
    model: str(asset.model),
    assigneeName: str(assignee?.name),
    assigneeDepartment: str(assignee?.department),
    assignedAt: str(assignee?.assigned_at),
    locationName: str(location?.name),
    locationPath: str(location?.full_path) || str(location?.name),
    fetchedAt: new Date().toISOString(),
  };
}

const sameCode = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

async function cacheDeviceInfo(config: InventoryConfig, body: any): Promise<InventoryDeviceInfo | null> {
  const info = parseDeviceInfo(body);
  if (info) {
    const entry: CachedDeviceInfo = {
      baseUrl: normalizeBaseUrl(config.baseUrl),
      assetCode: config.assetCode.trim(),
      info,
    };
    await AsyncStorage.setItem(KEYS.INVENTORY_DEVICE_INFO, JSON.stringify(entry)).catch(() => {});
  }
  return info;
}

/** Last device info received for the current server + asset code, or null. */
export async function getCachedDeviceInfo(config: InventoryConfig): Promise<InventoryDeviceInfo | null> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.INVENTORY_DEVICE_INFO);
    if (!raw) {
      return null;
    }
    const entry = JSON.parse(raw) as CachedDeviceInfo;
    if (entry.baseUrl !== normalizeBaseUrl(config.baseUrl) || !sameCode(entry.assetCode, config.assetCode)) {
      return null; // configured for another server or another tablet code since
    }
    return entry.info;
  } catch {
    return null;
  }
}

export interface DeviceInfoRefresh {
  info: InventoryDeviceInfo | null;
  /** Set when the refresh failed; info is then the cached copy (or null) */
  error?: InventoryOutcome;
}

/** Fetch device-info (read-only on the server, not rate limited) and update the cache. */
export async function refreshDeviceInfo(config: InventoryConfig): Promise<DeviceInfoRefresh> {
  const cached = await getCachedDeviceInfo(config);
  if (!isInventoryConfigured(config)) {
    return { info: null, error: missingConfigOutcome() };
  }
  const url = `${normalizeBaseUrl(config.baseUrl)}/api/inventory/device-info?asset_code=${encodeURIComponent(config.assetCode.trim())}`;
  try {
    const res = await request(url, config.apiKey.trim(), { method: 'GET' });
    if (res.status === 200 && res.body?.ok) {
      const info = await cacheDeviceInfo(config, res.body);
      return info ? { info } : { info: cached, error: toErrorOutcome({ status: 200, body: null }) };
    }
    if (res.status === 401 || res.status === 404 || res.status === 409) {
      // The cached card no longer describes this tablet (wrong code, revoked key...)
      await AsyncStorage.removeItem(KEYS.INVENTORY_DEVICE_INFO).catch(() => {});
      return { info: null, error: toErrorOutcome(res) };
    }
    return { info: cached, error: toErrorOutcome(res) };
  } catch (error) {
    return { info: cached, error: networkErrorOutcome(error) };
  }
}

export async function getInventoryConfig(): Promise<InventoryConfig> {
  const [baseUrl, assetCode, apiKey] = await Promise.all([
    AsyncStorage.getItem(KEYS.INVENTORY_BASE_URL).catch(() => null),
    AsyncStorage.getItem(KEYS.INVENTORY_ASSET_CODE).catch(() => null),
    getSecureInventoryKey(),
  ]);
  return { baseUrl: baseUrl || '', apiKey, assetCode: assetCode || '' };
}

export async function saveInventoryConfig(config: InventoryConfig): Promise<void> {
  await AsyncStorage.setItem(KEYS.INVENTORY_BASE_URL, normalizeBaseUrl(config.baseUrl));
  await AsyncStorage.setItem(KEYS.INVENTORY_ASSET_CODE, config.assetCode.trim());
  await saveSecureInventoryKey(config.apiKey);
}

export function isInventoryConfigured(config: InventoryConfig): boolean {
  return !!(config.baseUrl && config.apiKey && config.assetCode);
}

/** Trim, drop trailing slashes, default to https:// when no scheme was typed. */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) {
    u = `https://${u}`;
  }
  return u;
}

function uuidV4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** ISO-8601 in local time with the UTC offset, e.g. 2026-10-13T08:15:00+07:00 */
function localIsoWithOffset(d: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
}

async function safe<T>(p: Promise<T> | undefined, fallback: T): Promise<T> {
  try {
    return p ? await p : fallback;
  } catch {
    return fallback;
  }
}

async function buildDevicePayload() {
  const { KioskModule } = NativeModules;
  const [identity, systemInfo, battery, ip, version, deviceName] = await Promise.all([
    safe<{ androidId: string | null; serial: string | null; macAddress: string | null }>(
      KioskModule?.getInventoryIdentity?.(), { androidId: null, serial: null, macAddress: null }),
    safe<any>(KioskModule?.getSystemInfo?.(), null),
    safe<any>(KioskModule?.getBatteryStatus?.(), null),
    safe<string | null>(KioskModule?.getLocalIpAddress?.(), null),
    safe<any>(UpdateModule.getCurrentVersion(), null),
    safe(StorageService.getMqttDeviceName(), ''),
  ]);
  const model: string | null = systemInfo?.model || null;
  const level = battery?.level;
  return {
    device_name: deviceName || model,
    android_id: identity.androidId,
    serial: identity.serial,
    manufacturer: systemInfo?.manufacturer || null,
    model,
    os_version: systemInfo?.androidVersion ? `Android ${systemInfo.androidVersion}` : `Android API ${Platform.Version}`,
    app_version: version?.versionName || null,
    ip_address: ip && ip !== '0.0.0.0' ? ip : null,
    mac_address: identity.macAddress,
    battery_level: typeof level === 'number' && level >= 0 && level <= 100 ? Math.round(level) : null,
  };
}

interface HttpResult {
  status: number;
  body: any;
  /** Set when the server answered with something that is not API JSON (HTML page, etc.) */
  notJson?: { finalUrl: string; requestUrl: string; title: string | null };
}

async function request(url: string, apiKey: string, init: RequestInit): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null; // e.g. an HTML login or Vercel protection page
    }
    if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || null;
      return { status: res.status, body: null, notJson: { finalUrl: res.url || url, requestUrl: url, title } };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Fallback text when the server sent no usable JSON message. */
function errorMessageForStatus(status: number): string {
  switch (status) {
    case 401: return 'API key không hợp lệ hoặc đã bị thu hồi.';
    case 404: return 'Không tìm thấy tài sản hoặc sai địa chỉ máy chủ.';
    case 429: return 'Thao tác quá nhanh, vui lòng thử lại sau 1 phút.';
    default:
      return status >= 500
        ? 'Lỗi máy chủ, vui lòng thử lại.'
        : `Máy chủ trả về lỗi không xác định (HTTP ${status}).`;
  }
}

/** Strip the query string: it is noise on a small tablet banner. */
function shortUrl(u: string): string {
  return u.split('?')[0];
}

function toErrorOutcome(res: HttpResult): InventoryOutcome {
  if (res.notJson) {
    const { finalUrl, requestUrl, title } = res.notJson;
    const redirected = shortUrl(finalUrl) !== shortUrl(requestUrl);
    const where = redirected ? ` Bị chuyển hướng tới: ${shortUrl(finalUrl)}.` : ` Địa chỉ: ${shortUrl(requestUrl)}.`;
    const page = title ? ` (Trang: "${title}")` : '';
    return {
      kind: 'error',
      code: `not_api_${res.status}`,
      message:
        `Máy chủ trả về trang web thay vì dữ liệu API (HTTP ${res.status}).${where}${page} ` +
        'Kiểm tra: địa chỉ máy chủ chỉ gồm tên miền gốc; web đã deploy bản có API kiểm kê; ' +
        'Vercel Deployment Protection không chặn domain này.',
    };
  }
  return {
    kind: 'error',
    code: res.body?.error || `http_${res.status}`,
    message: (typeof res.body?.message === 'string' && res.body.message) || errorMessageForStatus(res.status),
  };
}

function networkErrorOutcome(error: unknown): InventoryOutcome {
  const aborted = (error as any)?.name === 'AbortError';
  return {
    kind: 'error',
    code: 'network_error',
    message: aborted
      ? 'Máy chủ không phản hồi (quá thời gian chờ). Kiểm tra kết nối mạng.'
      : 'Không kết nối được máy chủ. Kiểm tra mạng và địa chỉ máy chủ.',
  };
}

function missingConfigOutcome(): InventoryOutcome {
  return {
    kind: 'error',
    code: 'not_configured',
    message: 'Chưa cấu hình kiểm kê (địa chỉ máy chủ, API key, mã tài sản).',
  };
}

/** "Test connection": checks the key and the asset code, records nothing. */
export async function verifyInventoryConfig(config: InventoryConfig): Promise<InventoryOutcome> {
  if (!isInventoryConfigured(config)) {
    return missingConfigOutcome();
  }
  const url = `${normalizeBaseUrl(config.baseUrl)}/api/inventory/check-in/verify?asset_code=${encodeURIComponent(config.assetCode.trim())}`;
  try {
    const res = await request(url, config.apiKey.trim(), { method: 'GET' });
    if (res.status === 200 && res.body?.ok) {
      return {
        kind: 'success',
        code: 'verified',
        message: res.body.message || 'Kết nối thành công.',
        assetName: res.body.asset_name,
        deviceInfo: await cacheDeviceInfo(config, res.body),
      };
    }
    return toErrorOutcome(res);
  } catch (error) {
    return networkErrorOutcome(error);
  }
}

/** One button press = one request_id, reused across retries so the server deduplicates. */
export async function performInventoryCheckIn(): Promise<InventoryOutcome> {
  const config = await getInventoryConfig();
  if (!isInventoryConfigured(config)) {
    return missingConfigOutcome();
  }

  const payload = {
    request_id: uuidV4(),
    asset_code: config.assetCode.trim(),
    qr_payload: null,
    ...(await buildDevicePayload()),
    checked_in_at: localIsoWithOffset(new Date()),
  };
  const url = `${normalizeBaseUrl(config.baseUrl)}/api/inventory/check-in`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };

  let last: InventoryOutcome = networkErrorOutcome(null);
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      const res = await request(url, config.apiKey.trim(), init);
      if (res.status === 200 && res.body?.ok) {
        const result: string = res.body.result;
        return {
          kind: result === 'no_open_session' ? 'warning' : 'success',
          code: result,
          message: res.body.message || (result === 'no_open_session'
            ? 'Chưa có đợt kiểm kê nào đang mở cho thiết bị này.'
            : 'Kiểm kê thành công.'),
          assetName: res.body.asset_name,
          session: res.body.session ?? null,
          deviceInfo: await cacheDeviceInfo(config, res.body),
        };
      }
      last = toErrorOutcome(res);
      if (res.status < 500) {
        return last; // 4xx (incl. 429): retrying now would not help
      }
    } catch (error) {
      last = networkErrorOutcome(error);
    }
  }
  return last;
}
