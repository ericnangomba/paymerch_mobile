import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCodeSvg from 'react-native-qrcode-svg';
import { useColors } from '@/hooks/useColors';
import {
  AccountType,
  BusinessCategory,
  Transaction,
  UserProfile,
  PaymentRequest,
  PaymentRequestPreview,
  useWallet,
} from '@/state/paymerch-context';

type Screen = 'home' | 'pay' | 'scan' | 'vas' | 'activity' | 'settings';
type IconName = React.ComponentProps<typeof Feather>['name'];
type DeferredInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const businessCategories: BusinessCategory[] = [
  'Spaza shop',
  'Street vendor',
  'Carwash',
  'Tshisa nyama',
  'Street food stall',
  'Tomatoes & veggies',
  'Mini bus taxi',
];

const airtimeProviders = [
  { id: 'mtn', name: 'MTN', logo: '/vas-logos/mtn.png' },
  { id: 'vodacom', name: 'Vodacom', logo: '/vas-logos/vodacom.png' },
  { id: 'telkom', name: 'Telkom', logo: '/vas-logos/telkom.png' },
  { id: 'cellc', name: 'Cell C', logo: '/vas-logos/cellc.png' },
  { id: 'rain', name: 'rain', logo: '/vas-logos/rain.png' },
] as const;

const eskomProvider = { id: 'eskom', name: 'Eskom', logo: '/vas-logos/eskom.png' } as const;

// South African banks offered as demo payout destinations / top-up sources.
// Logos are bundled under public/bank-logos with sources in ATTRIBUTION.md;
// no bank partnership or integration is implied.
const saBanks = [
  { id: 'capitec', name: 'Capitec', logo: '/bank-logos/capitec.png' },
  { id: 'fnb', name: 'FNB', logo: '/bank-logos/fnb.png' },
  { id: 'standardbank', name: 'Standard Bank', logo: '/bank-logos/standardbank.png' },
  { id: 'absa', name: 'Absa', logo: '/bank-logos/absa.png' },
  { id: 'nedbank', name: 'Nedbank', logo: '/bank-logos/nedbank.png' },
  { id: 'tymebank', name: 'TymeBank', logo: '/bank-logos/tymebank.png' },
] as const;

type SaBank = (typeof saBanks)[number];

const findBank = (name?: string): SaBank | undefined => saBanks.find((bank) => bank.name === name);

const maskAccount = (num?: string): string => {
  if (!num) return 'No account linked';
  const digits = num.replace(/\D/g, '');
  return digits.length >= 4 ? `\u2022\u2022 ${digits.slice(-4)}` : 'No account linked';
};

const businessCategoryIcons: Record<BusinessCategory, IconName> = {
  'Spaza shop': 'shopping-bag',
  'Street vendor': 'map-pin',
  Carwash: 'droplet',
  'Tshisa nyama': 'coffee',
  'Street food stall': 'coffee',
  'Tomatoes & veggies': 'sun',
  'Mini bus taxi': 'truck',
};



const logo = require('../assets/images/paymerchlogo.png');
const logoMark = require('../assets/images/mlogo.png');

const formatSyncedAt = (ts: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  return new Date(ts).toLocaleString();
};

const zar = (amount: number) =>
  `R${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Payload encoded into the customer's one-time payment QR. A production build
 * would be a server-signed token (e.g. JWT); this local-first prototype encodes
 * the token, amount and expiry as a URL-safe string so any QR scanner can read
 * it and the merchant app can validate it against the local wallet state.
 */
type QrPayload = {
  token: string;
  amount: number;
  expiresAt: number;
  name: string;
};

const QR_PREFIX = 'PM1:';

// Keep the QR compact and robust: plain JSON, no URI escaping. Scanners still
// accept the legacy URI-escaped format (see decodeQrPayload), and old builds
// read this format because decodeURIComponent is a no-op on JSON without '%'.
const encodeQrPayload = (payload: QrPayload): string =>
  `${QR_PREFIX}${JSON.stringify(payload)}`;

const buildQrPayload = (request: PaymentRequest, name: string): QrPayload => ({
  token: request.token,
  amount: request.amount,
  expiresAt: request.expiresAt,
  name,
});

const decodeQrPayload = (data: string): QrPayload | null => {
  if (!data || data.length > 2048 || !data.startsWith(QR_PREFIX)) return null;
  const raw = data.slice(QR_PREFIX.length);
  let obj: unknown = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Codes generated before the compact format were URI-escaped.
    try {
      obj = JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  if (
    obj &&
    typeof obj === 'object' &&
    typeof (obj as QrPayload).token === 'string' &&
    (obj as QrPayload).token.length > 0 &&
    (obj as QrPayload).token.length <= 128 &&
    typeof (obj as QrPayload).amount === 'number' &&
    Number.isFinite((obj as QrPayload).amount) &&
    typeof (obj as QrPayload).expiresAt === 'number' &&
    Number.isFinite((obj as QrPayload).expiresAt) &&
    typeof (obj as QrPayload).name === 'string' &&
    (obj as QrPayload).name.length <= 100
  ) {
    return obj as QrPayload;
  }
  return null;
};

/**
 * Web QR detection. expo-camera's web barcode shim swallows detector errors
 * (its onError is never wired to CameraView) and delivers results wrapped as
 * { nativeEvent }, which the scan handler does not expect - so on web the
 * scanner runs its own loop over the camera <video>: native BarcodeDetector
 * where it exists (Chrome on Android), ZXing (pure JS, bundled) everywhere
 * else. A browser where neither works gets a visible error instead of a
 * camera that silently never detects.
 */
type NativeBarcodeDetector = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
};

type ZxingModule = typeof import('@zxing/library');

class WebQrDetector {
  private native: NativeBarcodeDetector | null = null;
  private nativeBroken = false;
  private zxing: ZxingModule | null = null;
  private zxingReader: InstanceType<ZxingModule['QRCodeReader']> | null = null;
  private zxingBroken = false;
  private canvas: HTMLCanvasElement | null = null;

  async detect(video: HTMLVideoElement): Promise<string | null> {
    if (!this.nativeBroken && !this.native) {
      try {
        const Ctor = (
          globalThis as unknown as {
            BarcodeDetector?: new (options: { formats: string[] }) => NativeBarcodeDetector;
          }
        ).BarcodeDetector;
        if (!Ctor) throw new Error('BarcodeDetector unavailable');
        const detector = new Ctor({ formats: ['qr_code'] });
        await detector.detect(video); // probe: some builds expose the class but cannot detect
        this.native = detector;
      } catch {
        this.native = null;
        this.nativeBroken = true;
      }
    }
    if (this.native) {
      try {
        const results = await this.native.detect(video);
        if (results.length > 0 && results[0].rawValue) return results[0].rawValue;
        return null;
      } catch {
        this.native = null;
        this.nativeBroken = true;
      }
    }
    if (this.zxingBroken) return null;
    try {
      if (!this.zxing) {
        this.zxing = await import('@zxing/library');
        this.zxingReader = new this.zxing.QRCodeReader();
      }
      const z = this.zxing;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return null;
      this.canvas = this.canvas ?? document.createElement('canvas');
      this.canvas.width = width;
      this.canvas.height = height;
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, width, height);
      const frame = ctx.getImageData(0, 0, width, height);
      const gray = new Uint8ClampedArray(width * height);
      for (let i = 0, j = 0; i < frame.data.length; i += 4, j++) {
        gray[j] = (frame.data[i] + frame.data[i + 1] * 2 + frame.data[i + 2]) / 4;
      }
      const source = new z.RGBLuminanceSource(gray, width, height);
      const bitmap = new z.BinaryBitmap(new z.HybridBinarizer(source));
      return this.zxingReader ? this.zxingReader.decode(bitmap).getText() : null;
    } catch (error) {
      if (!this.zxing) {
        // The fallback module itself failed to load: no detector remains.
        this.zxingBroken = true;
        return null;
      }
      const z = this.zxing;
      if (
        error instanceof z.NotFoundException ||
        error instanceof z.FormatException ||
        error instanceof z.ChecksumException
      ) {
        return null; // no decodable code in this frame
      }
      return null;
    }
  }

  get unavailable(): boolean {
    return this.nativeBroken && this.zxingBroken;
  }
}

const timeLabel = (timestamp: number) => {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};

const initialsFor = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'PM';

function HapticPressable({
  children,
  onPress,
  style,
  disabled,
  testID,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: any;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={() => {
        if (disabled) return;
        onPress?.();
      }}
      style={({ pressed }) => [style, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {children}
    </Pressable>
  );
}

function BrandMark({ size = 42 }: { size?: number }) {
  return <Image source={logo} style={{ width: size * 2, height: size * 2 }} resizeMode="contain" />;
}

/** Small icon-only mark (the m-logo) used where the logo is tiny, e.g. the header. */
function LogoIcon({ size = 40 }: { size?: number }) {
  return <Image source={logoMark} style={{ width: size, height: size }} resizeMode="contain" />;
}

function StatusPill({ online, colors }: { online: boolean; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.statusPill, { backgroundColor: online ? colors.accent : colors.warm }]}>
      <View style={[styles.statusDot, { backgroundColor: online ? colors.success : colors.warning }]} />
      <Text style={[styles.statusText, { color: online ? colors.accentForeground : colors.warning }]}>
        {online ? 'Online' : 'Offline'}
      </Text>
    </View>
  );
}

function PinConfirmationModal({
  visible,
  onConfirm,
  onCancel,
  title,
  summary,
  error: externalError,
  onClearError,
}: {
  visible: boolean;
  onConfirm: (pin: string) => void | Promise<void>;
  onCancel: () => void;
  title: string;
  summary?: string;
  error?: string;
  onClearError?: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const { demoMode, demoPin } = useWallet();

  // Use external error if provided
  const displayError = externalError || error;

  const complete = (next: string) => {
    // Await the confirm handler so an outcome that keeps the sheet open (a
    // rejected PIN) gives the pad back instead of a permanently stuck
    // "Processing payment…" spinner; the user can retype immediately.
    // Outcomes that close the sheet reset through the visibility effect.
    void Promise.resolve(onConfirm(next)).finally(() => {
      setIsProcessing(false);
      setPin('');
    });
  };

  const handleDigit = (digit: string) => {
    if (pin.length >= 6 || isProcessing) return;
    const next = `${pin}${digit}`;
    setPin(next);
    setError('');
    onClearError?.();
    if (next.length === 6) {
      setIsProcessing(true);
      complete(next);
    }
  };

  const handleDelete = () => {
    if (isProcessing) return;
    setPin((value) => value.slice(0, -1));
    setError('');
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!visible) {
      setPin('');
      setError('');
      setIsProcessing(false);
    }
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.pinSheet, { backgroundColor: colors.card }]}>
          <ScrollView
            style={styles.pinSheetScroll}
            contentContainerStyle={[styles.pinSheetContent, { paddingBottom: Math.max(insets.bottom, 12) + 14 }]}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
          <View style={styles.sheetHandle} />
          <View style={styles.pinModalHeader}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>SECURITY CHECK</Text>
              <Text style={[styles.pinModalTitle, { color: colors.foreground }]}>{title}</Text>
            </View>
            <HapticPressable onPress={onCancel} style={styles.closeButton}>
              <Feather name="x" size={20} color={colors.foreground} />
            </HapticPressable>
          </View>
          {summary ? (
            <View style={[styles.pinSummary, { backgroundColor: colors.accent }]}>
              <Feather name="arrow-right-circle" size={16} color={colors.accentForeground} />
              <Text style={[styles.pinSummaryText, { color: colors.accentForeground }]}>{summary}</Text>
            </View>
          ) : null}
          <Text style={[styles.authSubtitle, { color: colors.mutedForeground }, { textAlign: 'center', marginTop: 10 }]}>
            Enter your 6-digit PIN to confirm this transaction
          </Text>
          {demoMode ? (
            <Text style={[styles.authSubtitle, { color: colors.mutedForeground }, { textAlign: 'center', marginTop: 2 }]}>
              Demo mode: use PIN {demoPin}
            </Text>
          ) : null}
          <View style={styles.pinDots}>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <View
                key={index}
                style={[styles.pinDot, { backgroundColor: index < pin.length ? colors.button : colors.border }]}
              />
            ))}
          </View>
          {displayError ? <Text style={[styles.errorText, { color: colors.destructive }]}>{displayError}</Text> : null}
          {isProcessing ? (
            <View style={styles.processingBlock}>
              <ActivityIndicator size="large" color={colors.button} />
              <Text style={[styles.processingText, { color: colors.mutedForeground }]}>Processing payment…</Text>
            </View>
          ) : (
            <View style={styles.pinPad}>
              {keys.map((key) => (
                <HapticPressable key={key} onPress={() => void handleDigit(key)} style={[styles.pinKey, { backgroundColor: colors.muted }]}>
                  <Text style={[styles.pinKeyText, { color: colors.foreground }]}>{key}</Text>
                </HapticPressable>
              ))}
              <View style={[styles.pinKey, { backgroundColor: 'transparent' }]} />
              <HapticPressable onPress={() => void handleDigit('0')} style={[styles.pinKey, { backgroundColor: colors.muted }]}>
                <Text style={[styles.pinKeyText, { color: colors.foreground }]}>0</Text>
              </HapticPressable>
              <HapticPressable onPress={handleDelete} style={[styles.pinKey, { backgroundColor: colors.muted }]}>
                <Feather name="delete" size={21} color={colors.foreground} />
              </HapticPressable>
            </View>
          )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function AuthScreen({ initialAuthMode }: { initialAuthMode?: 'login' | 'register' }) {
  const colors = useColors();
  const { login, loginWithPhone, biometricLogin, isRegistered, biometricAvailable, biometricLabel, verifyBiometrics, enterDemoMode } = useWallet();
  // An explicit entry choice from the splash (register pills vs log-in link)
  // wins on mount; without one, registered devices land on the PIN pad and
  // unregistered devices on registration, as before.
  const [mode, setMode] = useState<'login' | 'register'>(initialAuthMode ?? (isRegistered ? 'login' : 'register'));
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [registrationMessage, setRegistrationMessage] = useState('');
  const [loginPhone, setLoginPhone] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  // Existing-account login for a device with no local profile (fresh install,
  // cleared storage, or after leaving the demo): phone + PIN against the
  // pilot server, which restores the full account on success.
  const handlePhoneLogin = async () => {
    if (loginBusy) return;
    const digitCount = loginPhone.replace(/\D/g, '').length;
    if (digitCount < 9 || digitCount > 15) {
      setError('Enter the mobile number you registered with.');
      return;
    }
    if (loginPin.length !== 6) {
      setError('Enter your 6-digit PIN.');
      return;
    }
    setLoginBusy(true);
    setError('');
    try {
      const outcome = await loginWithPhone(loginPhone, loginPin);
      if (outcome === 'OFFLINE') {
        setError('No connection right now. Check your signal and try again.');
      } else if (outcome !== 'OK') {
        setError('Invalid phone number or PIN. Please try again.');
      }
    } finally {
      setLoginBusy(false);
      setLoginPin('');
    }
  };

  // Registered wallets land on the PIN pad; unregistered ones on registration.
  // Entering demo mode marks a prepared profile as registered, which brings
  // up its demo-PIN login without touching the registration form. An explicit
  // splash choice (initialAuthMode) is not overridden on mount.
  const modeFollowsRegistration = useRef(!initialAuthMode);
  useEffect(() => {
    if (modeFollowsRegistration.current) {
      setMode(isRegistered ? 'login' : 'register');
      return;
    }
    modeFollowsRegistration.current = true;
  }, [isRegistered]);

  const handleBiometricUnlock = async () => {
    setError('');
    if (Platform.OS === 'web') {
      setError('Biometrics are available on a physical device. Use your PIN in this preview.');
      return;
    }
    if (!biometricAvailable) {
      setError('No enrolled biometrics were found. Use your 6-digit PIN instead.');
      return;
    }
    const ok = await verifyBiometrics();
    if (ok) {
      await biometricLogin();
    } else {
      setError('Biometric unlock was not completed. Use your 6-digit PIN.');
    }
  };

  const enterDigit = async (digit: string) => {
    if (pin.length >= 6) return;
    const next = `${pin}${digit}`;
    setPin(next);
    setError('');
    setRegistrationMessage('');
    if (next.length === 6) {
      const outcome = await login(next);
      if (outcome === 'OFFLINE') {
        setError('No connection right now. Check your signal and try again.');
        setPin('');
      } else if (outcome !== 'OK') {
        setError('That PIN did not match. Please try again.');
        setPin('');
      }
    }
  };

  const deleteDigit = () => setPin((value) => value.slice(0, -1));
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  if (mode === 'register') {
    return (
      <RegistrationScreen
        onBack={() => setMode('login')}
        onRegistered={() => {
          setMode('login');
          setPin('');
          setRegistrationMessage('Account created. Log in with your new PIN to open your ledger.');
        }}
      />
    );
  }

  const phoneLoginContent = (
    <ScrollView
      style={[styles.authRoot, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.authScrollContent}
      showsVerticalScrollIndicator={false}
      bounces={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.authTop}>
        <Image source={logo} style={{ width: 210, height: 63, marginTop: 8 }} resizeMode="contain" />
        <Text style={styles.authTagline}>Get paid with one scan.</Text>
      </View>
      <View style={[styles.authSheet, { backgroundColor: colors.card }]}>
        <Text style={[styles.authEyebrow, { color: colors.mutedForeground }]}>EXISTING ACCOUNT</Text>
        <Text style={[styles.authTitle, { color: colors.foreground }]}>Log in</Text>
        <Text style={[styles.authSubtitle, { color: colors.mutedForeground }]}>
          Enter the mobile number and PIN you registered with. Your wallet restores from the pilot server.
        </Text>
        <View style={styles.registrationFieldGroup}>
          <Text style={[styles.registrationFieldLabel, { color: colors.foreground }]}>MOBILE NUMBER</Text>
          <View style={[styles.registrationInputShell, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="smartphone" size={18} color={colors.mutedForeground} />
            <TextInput
              value={loginPhone}
              onChangeText={(value) => { setLoginPhone(value); setError(''); }}
              placeholder="+27 72 555 0198"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="phone-pad"
              autoCapitalize="none"
              style={[styles.registrationInput, { color: colors.foreground }]}
              returnKeyType="next"
              testID="login-phone"
            />
          </View>
        </View>
        <View style={styles.registrationFieldGroup}>
          <Text style={[styles.registrationFieldLabel, { color: colors.foreground }]}>6-DIGIT PIN</Text>
          <View style={[styles.registrationInputShell, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="lock" size={18} color={colors.mutedForeground} />
            <TextInput
              value={loginPin}
              onChangeText={(value) => { setLoginPin(value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
              placeholder="Your PIN"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              style={[styles.registrationInput, { color: colors.foreground }]}
              returnKeyType="done"
              onSubmitEditing={() => void handlePhoneLogin()}
              testID="login-pin"
            />
          </View>
        </View>
        {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}
        <HapticPressable onPress={() => void handlePhoneLogin()} style={[styles.registrationSubmitButton, { backgroundColor: colors.button }]} testID="login-submit">
          <Feather name="log-in" size={18} color={colors.buttonForeground} />
          <Text style={[styles.registrationSubmitText, { color: colors.buttonForeground }]}>{loginBusy ? 'Logging in…' : 'Log in'}</Text>
          <Feather name="arrow-right" size={18} color={colors.buttonForeground} />
        </HapticPressable>
        <HapticPressable onPress={() => { setError(''); setMode('register'); }} style={styles.biometricButton} testID="goto-register">
          <Feather name="user-plus" size={17} color={colors.primary} />
          <Text style={[styles.biometricText, { color: colors.primary }]}>New here? Create an account</Text>
        </HapticPressable>
      </View>
    </ScrollView>
  );

  const pinPadContent = (
    <ScrollView
      style={[styles.authRoot, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.authScrollContent}
      showsVerticalScrollIndicator={false}
      bounces={false}
    >
      <View style={styles.authTop}>
        <Image source={logo} style={{ width: 210, height: 63, marginTop: 8 }} resizeMode="contain" />
        <Text style={styles.authTagline}>Get paid with one scan.</Text>
      </View>
      <View style={[styles.authSheet, { backgroundColor: colors.card }]}>
        <Text style={[styles.authEyebrow, { color: colors.mutedForeground }]}>WELCOME BACK</Text>
        <Text style={[styles.authTitle, { color: colors.foreground }]}>Enter your PIN</Text>
        <Text style={[styles.authSubtitle, { color: colors.mutedForeground }]}>
          Confirm your PIN to pay and unlock your wallet.
        </Text>
        <View style={styles.pinDots}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <View
              key={index}
              style={[styles.pinDot, { backgroundColor: index < pin.length ? colors.button : colors.border }]}
            />
          ))}
        </View>
        {registrationMessage ? <Text style={[styles.errorText, { color: colors.success }]}>{registrationMessage}</Text> : null}
        {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}
        <View style={styles.pinPad}>
          {keys.map((key) => (
            <HapticPressable key={key} testID={`pin-${key}`} onPress={() => void enterDigit(key)} style={[styles.pinKey, { backgroundColor: colors.muted }]}>
              <Text style={[styles.pinKeyText, { color: colors.foreground }]}>{key}</Text>
            </HapticPressable>
          ))}
          <HapticPressable onPress={() => void handleBiometricUnlock()} style={[styles.pinKey, { backgroundColor: colors.muted }]}>
            <Feather name="lock" size={20} color={colors.foreground} />
          </HapticPressable>
          <HapticPressable onPress={() => void enterDigit('0')} style={[styles.pinKey, { backgroundColor: colors.muted }]}>
            <Text style={[styles.pinKeyText, { color: colors.foreground }]}>0</Text>
          </HapticPressable>
          <HapticPressable onPress={deleteDigit} style={[styles.pinKey, { backgroundColor: colors.muted }]}>
            <Feather name="delete" size={21} color={colors.foreground} />
          </HapticPressable>
        </View>
        {biometricAvailable ? (
          <HapticPressable onPress={() => void handleBiometricUnlock()} style={styles.biometricButton}>
            <Feather name="smartphone" size={17} color={colors.primary} />
            <Text style={[styles.biometricText, { color: colors.primary }]}>{biometricLabel}</Text>
          </HapticPressable>
        ) : null}
        <HapticPressable onPress={() => void enterDemoMode()} style={styles.biometricButton} testID="enter-demo">
          <Feather name="play-circle" size={17} color={colors.primary} />
          <Text style={[styles.biometricText, { color: colors.primary }]}>Explore the demo</Text>
        </HapticPressable>
        <Text style={[styles.demoHint, { color: colors.mutedForeground }]}>
          The demo uses prepared dummy profiles and test money on this device only. No real details are collected.
        </Text>
        <Text style={[styles.demoHint, { color: colors.mutedForeground }]}>
          {biometricAvailable ? 'Enter your 6-digit PIN to unlock' : 'Use your 6-digit PIN to unlock (enroll biometrics in device settings to enable this option)'}
        </Text>
        <Text style={[styles.secureFooter, { color: colors.mutedForeground }]}>
          <Feather name="shield" size={12} /> Your wallet is secured on this device
        </Text>
      </View>
    </ScrollView>
  );

  // The welcome-back PIN pad only makes sense with a locally stored profile;
  // without one, the phone-number login is the working route back in.
  const authContent = isRegistered ? pinPadContent : phoneLoginContent;

  // Add web container for proper centering on web
  if (Platform.OS === 'web') {
    return (
      <View style={styles.webContainer}>
        {authContent}
      </View>
    );
  }

  return authContent;
}

function AppSplashScreen({
  onRegister,
  onLogin,
  onInstall,
  onWatchDemo,
}: {
  onRegister: () => void;
  onLogin: () => void;
  onInstall?: () => void;
  onWatchDemo: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [webHeight, setWebHeight] = useState(() =>
    typeof window === 'undefined' ? windowHeight : window.innerHeight,
  );
  const compactLayout = (Platform.OS === 'web' ? webHeight : windowHeight) < 700;
  const heroOpacity = useMemo(() => new Animated.Value(0), []);
  const heroTranslateY = useMemo(() => new Animated.Value(14), []);
  const actionOpacity = useMemo(() => new Animated.Value(0), []);

  useEffect(() => {
    const useNativeDriver = Platform.OS !== 'web';
    const animation = Animated.parallel([
      Animated.timing(heroOpacity, {
        toValue: 1,
        duration: 420,
        useNativeDriver,
      }),
      Animated.timing(heroTranslateY, {
        toValue: 0,
        duration: 420,
        useNativeDriver,
      }),
      Animated.timing(actionOpacity, {
        toValue: 1,
        duration: 420,
        delay: 120,
        useNativeDriver,
      }),
    ]);

    animation.start();
    return () => animation.stop();
  }, [actionOpacity, heroOpacity, heroTranslateY]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const updateHeight = () => setWebHeight(window.innerHeight);
    window.addEventListener('resize', updateHeight);
    updateHeight();
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  const splashContent = (
    <LinearGradient
      colors={['#F8F1E2', '#F3E9CF', '#F8F1E2']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.splashGradient}
    >
      <ScrollView
        style={styles.splashScroll}
        contentContainerStyle={[
          styles.splashRoot,
          compactLayout && styles.splashRootCompact,
          {
            paddingTop: Math.max(insets.top + (compactLayout ? 10 : 18), compactLayout ? 14 : 26),
            paddingBottom: Math.max(insets.bottom + (compactLayout ? 10 : 18), compactLayout ? 14 : 26),
          },
        ]}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <Animated.View
          style={[
            styles.splashHero,
            compactLayout && styles.splashHeroCompact,
            {
              opacity: heroOpacity,
              transform: [{ translateY: heroTranslateY }],
            },
          ]}
        >
          <Image
            source={logo}
            style={[
              { width: compactLayout ? 190 : 228, height: compactLayout ? 57 : 68 },
              compactLayout ? { marginTop: 8 } : { marginTop: 14 },
            ]}
            resizeMode="contain"
          />
          <Text style={styles.splashHeadline}>Get paid with one scan.</Text>
          <Text style={styles.splashSubline}>No card machine. No printed code. Your phone is the till.</Text>
        </Animated.View>

        <Animated.View style={[styles.splashMiddle, compactLayout && styles.splashMiddleCompact, { opacity: actionOpacity }]}>
          <HapticPressable onPress={onRegister} style={styles.splashPill} testID="splash-register">
            <Text style={styles.splashPillText}>Create an account</Text>
            <Feather name="arrow-right" size={18} color="#211A12" />
          </HapticPressable>
          <HapticPressable onPress={onLogin} style={[styles.splashSecondaryCta, styles.splashLoginCta]} testID="splash-login">
            <Feather name="log-in" size={16} color="#211A12" />
            <Text style={[styles.splashSecondaryCtaText, windowWidth < 380 && { fontSize: 13.5 }]}>Already have an account? Log in</Text>
          </HapticPressable>
          <HapticPressable onPress={onWatchDemo} style={styles.splashInstallAction} testID="splash-watch-demo">
            <Text style={styles.splashQuietLink}>Watch a demo payment first</Text>
          </HapticPressable>
          <View style={styles.splashChipsRow}>
            {['Spaza shop', 'Tshisa nyama', 'Taxi', 'Street vendor'].map((chip) => (
              <View key={chip} style={styles.splashChip}>
                <Text style={styles.splashChipText}>{chip}</Text>
              </View>
            ))}
          </View>
          {onInstall ? (
            <HapticPressable onPress={onInstall} style={styles.splashInstallAction} testID="splash-install">
              <Feather name="download" size={16} color="#453F33" />
              <Text style={styles.splashInstallText}>Install Paymerch</Text>
            </HapticPressable>
          ) : null}
          <View style={styles.splashSecurityNote}>
            <Feather name="shield" size={13} color="#6B6558" />
            <Text style={styles.splashSecurityText}>Test-money pilot · no real payments · secured with your 6-digit PIN</Text>
          </View>
        </Animated.View>
      </ScrollView>
    </LinearGradient>
  );

  if (Platform.OS === 'web') {
    return <View style={styles.webContainer}>{splashContent}</View>;
  }

  return splashContent;
}

// Registration draft: safe fields only. The PIN, PIN confirmation, bank
// account holder and bank account number are never persisted - they are
// re-entered at submission time on the live server.
type RegistrationDraft = {
  accountType: AccountType;
  name: string;
  phone: string;
  businessCategory: BusinessCategory;
  bankId: string | null;
  bankAccountType: 'Cheque' | 'Savings';
};
const REGISTRATION_DRAFT_KEY = 'paymerch-registration-draft-v1';

function RegistrationScreen({ onBack, onRegistered, initialAccountType }: { onBack: () => void; onRegistered: () => void; initialAccountType?: AccountType | null }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { registerAccount, enterDemoMode, online } = useWallet();
  const [accountType, setAccountType] = useState<AccountType>(initialAccountType ?? 'business');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState<BusinessCategory>('Spaza shop');
  const [bankId, setBankId] = useState<string | null>(null);
  const [bankAccountHolder, setBankAccountHolder] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankAccountType, setBankAccountType] = useState<'Cheque' | 'Savings'>('Cheque');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [draftNotice, setDraftNotice] = useState(false);

  // Restore a saved draft once. Only non-secret fields come back; the banner
  // makes clear the account was never created.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(REGISTRATION_DRAFT_KEY);
        if (!raw || cancelled) return;
        const draft = JSON.parse(raw) as Partial<RegistrationDraft>;
        if (draft.accountType === 'business' || draft.accountType === 'individual') setAccountType(draft.accountType);
        if (typeof draft.name === 'string') setName(draft.name);
        if (typeof draft.phone === 'string') setPhone(draft.phone);
        if (draft.businessCategory) setCategory(draft.businessCategory as BusinessCategory);
        if (typeof draft.bankId === 'string') setBankId(draft.bankId);
        if (draft.bankAccountType === 'Cheque' || draft.bankAccountType === 'Savings') setBankAccountType(draft.bankAccountType);
        if (!cancelled) setDraftNotice(true);
      } catch {
        await AsyncStorage.removeItem(REGISTRATION_DRAFT_KEY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Save the draft as the form fills in, so a dropped connection or a closed
  // app never loses the details. Nothing is submitted until the user taps
  // Create account while online.
  useEffect(() => {
    if (!name && !phone && !bankId) return;
    const draft: RegistrationDraft = { accountType, name, phone, businessCategory: category, bankId, bankAccountType };
    void AsyncStorage.setItem(REGISTRATION_DRAFT_KEY, JSON.stringify(draft));
  }, [accountType, name, phone, category, bankId, bankAccountType]);

  const discardDraft = async () => {
    await AsyncStorage.removeItem(REGISTRATION_DRAFT_KEY);
    setDraftNotice(false);
    setName('');
    setPhone('');
    setBankId(null);
    setBankAccountType('Cheque');
    setCategory('Spaza shop');
  };

  const submit = async () => {
    if (!online) {
      setError('You are offline. Your details are saved as a draft on this device - come back and submit when you are connected. No account is created until then.');
      return;
    }
    const normalizedPhone = phone.replace(/\D/g, '');
    if (name.trim().length < 2) {
      setError(accountType === 'business' ? 'Enter your business or trading name.' : 'Enter your full name.');
      return;
    }
    if (normalizedPhone.length < 9) {
      setError('Enter a valid mobile number.');
      return;
    }
    const selectedBank = saBanks.find((bank) => bank.id === bankId);
    if (!selectedBank) {
      setError('Choose your bank. This is where cash-outs would be paid in production.');
      return;
    }
    const trimmedAccountNumber = bankAccountNumber.replace(/\D/g, '');
    if (trimmedAccountNumber && (trimmedAccountNumber.length < 6 || trimmedAccountNumber.length > 16)) {
      setError('A bank account number is 6 to 16 digits. Use a made-up one for this demo.');
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      setError('Your PIN must be exactly 6 digits.');
      return;
    }
    if (pin !== confirmPin) {
      setError('Your PINs do not match.');
      return;
    }
    const profile: UserProfile = {
      accountType,
      name: name.trim(),
      phone: phone.trim(),
      ...(accountType === 'business' ? { businessCategory: category } : {}),
      bankName: selectedBank.name,
      bankAccountHolder: bankAccountHolder.trim() || name.trim(),
      ...(trimmedAccountNumber ? { bankAccountNumber: trimmedAccountNumber } : {}),
      bankAccountType,
    };
    const ok = await registerAccount(profile, pin);
    if (!ok) {
      setError('Could not create your account. The number may already be registered, or the server is unreachable. Your details stay saved on this device as a draft.');
      return;
    }
    await AsyncStorage.removeItem(REGISTRATION_DRAFT_KEY);
    onRegistered();
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.registrationRoot, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 28 }]}
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: colors.background }}
    >
      <View style={styles.registrationHeader}>
        <HapticPressable onPress={onBack} style={[styles.registrationBackButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="arrow-left" size={19} color={colors.foreground} />
        </HapticPressable>
        <View style={styles.registrationProgress}>
          <View style={[styles.registrationProgressTrack, { backgroundColor: colors.border }]}>
            <View style={[styles.registrationProgressFill, { backgroundColor: colors.button }]} />
          </View>
          <Text style={[styles.registrationProgressText, { color: colors.mutedForeground }]}>ACCOUNT SETUP</Text>
        </View>
        <View style={{ width: 44 }} />
      </View>
      <View style={styles.registrationIntro}>
        <View style={[styles.registrationEyebrow, { backgroundColor: colors.accent }]}>
          <Feather name="shield" size={13} color={colors.accentForeground} />
          <Text style={[styles.authEyebrow, { color: colors.accentForeground }]}>FIRST TIME SETUP</Text>
        </View>
        <Text style={[styles.registrationTitle, { color: colors.foreground }]}>Create your wallet</Text>
        <Text style={[styles.registrationSubtitle, { color: colors.mutedForeground }]}>
          Set up your account and PIN for secure transactions.
        </Text>
      </View>
      {draftNotice ? (
        <View style={[styles.offlineBanner, { backgroundColor: colors.warm, marginHorizontal: 20, marginBottom: 12 }]}>
          <Feather name="edit-3" size={17} color={colors.warning} />
          <View style={styles.offlineCopy}>
            <Text style={[styles.offlineTitle, { color: colors.foreground }]}>Draft restored</Text>
            <Text style={[styles.offlineText, { color: colors.mutedForeground }]}>
              Your account is not created yet. Review your details and tap Create account while you are online. For your security your PIN and bank account number were not saved.
            </Text>
            <HapticPressable onPress={() => void discardDraft()}>
              <Text style={[styles.offlineText, { color: colors.destructive, fontFamily: 'Montserrat_600SemiBold' }]}>Discard draft</Text>
            </HapticPressable>
          </View>
        </View>
      ) : null}
      <View style={styles.registrationSection}>
        <Text style={[styles.registrationSectionTitle, { color: colors.foreground }]}>I am registering as</Text>
        <Text style={[styles.registrationSectionHint, { color: colors.mutedForeground }]}>Choose the account that best describes you.</Text>
      </View>
      <View style={styles.accountTypeOptions}>
        {(['business', 'individual'] as AccountType[]).map((type) => {
          const selected = accountType === type;
          return (
            <HapticPressable
              key={type}
              onPress={() => { setAccountType(type); setError(''); }}
              style={[
                styles.accountTypeCard,
                { backgroundColor: colors.card, borderColor: selected ? colors.button : colors.border },
                selected && { backgroundColor: colors.accent },
              ]}
            >
              <View style={[styles.accountTypeIcon, { backgroundColor: selected ? colors.button : colors.muted }]}>
                <Feather name={type === 'business' ? 'briefcase' : 'user'} size={18} color={selected ? colors.buttonForeground : colors.mutedForeground} />
              </View>
              <View style={styles.accountTypeCopy}>
                <Text style={[styles.accountTypeTitle, { color: colors.foreground }]}>{type === 'business' ? 'Business' : 'Individual'}</Text>
                <Text style={[styles.accountTypeDescription, { color: colors.mutedForeground }]}>
                  {type === 'business' ? 'For your shop or trade' : 'For personal use'}
                </Text>
              </View>
              <View style={[styles.selectionIndicator, { borderColor: selected ? colors.button : colors.border, backgroundColor: selected ? colors.button : 'transparent' }]}>
                {selected ? <Feather name="check" size={12} color={colors.buttonForeground} /> : null}
              </View>
            </HapticPressable>
          );
        })}
      </View>
      <View style={styles.registrationFieldGroup}>
        <Text style={[styles.registrationFieldLabel, { color: colors.foreground }]}>
          {accountType === 'business' ? 'BUSINESS OR TRADING NAME' : 'FULL NAME'}
        </Text>
        <View style={[styles.registrationInputShell, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name={accountType === 'business' ? 'briefcase' : 'user'} size={18} color={colors.mutedForeground} />
          <TextInput
            value={name}
            onChangeText={(value) => { setName(value); setError(''); }}
            placeholder={accountType === 'business' ? 'e.g. Lungile’s Spaza' : 'e.g. Lungile Mokoena'}
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="words"
            style={[styles.registrationInput, { color: colors.foreground }]}
            returnKeyType="next"
          />
        </View>
      </View>
      {accountType === 'business' ? (
        <View style={styles.registrationFieldGroup}>
          <Text style={[styles.registrationFieldLabel, { color: colors.foreground }]}>TYPE OF BUSINESS</Text>
          <View style={styles.registrationCategoryGrid}>
            {businessCategories.map((item) => {
              const selected = category === item;
              return (
                <HapticPressable
                  key={item}
                  onPress={() => setCategory(item)}
                  style={[
                    styles.registrationCategoryCard,
                    { backgroundColor: colors.card, borderColor: selected ? colors.button : colors.border },
                    selected && { backgroundColor: colors.accent },
                  ]}
                >
                  <Feather name={businessCategoryIcons[item]} size={16} color={selected ? colors.button : colors.mutedForeground} />
                  <Text style={[styles.registrationCategoryText, { color: colors.foreground }]}>{item}</Text>
                  {selected ? <Feather name="check-circle" size={15} color={colors.button} /> : null}
                </HapticPressable>
              );
            })}
          </View>
        </View>
      ) : null}
      <View style={styles.registrationFieldGroup}>
        <Text style={[styles.registrationFieldLabel, { color: colors.foreground }]}>MOBILE NUMBER</Text>
        <View style={[styles.registrationInputShell, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="smartphone" size={18} color={colors.mutedForeground} />
          <TextInput
            value={phone}
            onChangeText={(value) => { setPhone(value); setError(''); }}
            placeholder="+27 72 555 0198"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="phone-pad"
            style={[styles.registrationInput, { color: colors.foreground }]}
            returnKeyType="next"
          />
        </View>
      </View>
      <View style={styles.registrationFieldGroup}>
        <Text style={[styles.registrationFieldLabel, { color: colors.foreground }]}>YOUR BANK</Text>
        <Text style={[styles.registrationSectionHint, { color: colors.mutedForeground, marginBottom: 12 }]}>
          {accountType === 'business' ? 'Where your cash-outs would be paid in production.' : 'Where your top-ups would come from in production.'}
        </Text>
        <BankPicker selectedId={bankId} onSelect={(bank) => { setBankId(bank.id); setError(''); }} />
      </View>
      {bankId ? (
        <View style={styles.registrationFieldGroup}>
          <Text style={[styles.registrationFieldLabel, { color: colors.foreground }]}>ACCOUNT DETAILS (DEMO)</Text>
          <View style={[styles.registrationInputShell, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="user" size={18} color={colors.mutedForeground} />
            <TextInput
              value={bankAccountHolder}
              onChangeText={(value) => { setBankAccountHolder(value); setError(''); }}
              placeholder="Account holder (defaults to your name)"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="words"
              style={[styles.registrationInput, { color: colors.foreground }]}
              returnKeyType="next"
            />
          </View>
          <View style={[styles.registrationInputShell, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
            <Feather name="hash" size={18} color={colors.mutedForeground} />
            <TextInput
              value={bankAccountNumber}
              onChangeText={(value) => { setBankAccountNumber(value.replace(/\D/g, '').slice(0, 16)); setError(''); }}
              placeholder="Account number (made-up, optional)"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
              style={[styles.registrationInput, { color: colors.foreground }]}
              returnKeyType="next"
            />
          </View>
          <View style={styles.registrationBankTypeRow}>
            {(['Cheque', 'Savings'] as const).map((type) => {
              const selected = bankAccountType === type;
              return (
                <HapticPressable
                  key={type}
                  onPress={() => setBankAccountType(type)}
                  style={[styles.registrationBankTypeChip, { backgroundColor: selected ? colors.active : colors.muted, borderColor: selected ? colors.active : colors.border }]}
                >
                  <Text style={[styles.registrationBankTypeText, { color: selected ? colors.activeForeground : colors.foreground }]}>{type}</Text>
                </HapticPressable>
              );
            })}
          </View>
          <View style={[styles.registrationBankNote, { backgroundColor: colors.warm }]}>
            <Feather name="info" size={14} color={colors.warning} />
            <Text style={[styles.registrationBankNoteText, { color: colors.foreground }]}>
              Pilot demo: no real payouts or debits happen. Use a made-up account number, not your real banking details.
            </Text>
          </View>
        </View>
      ) : null}
      <View style={styles.registrationPinSection}>
        <View style={styles.registrationPinHeading}>
          <View>
            <Text style={[styles.registrationSectionTitle, { color: colors.foreground }]}>Create a 6-digit PIN</Text>
            <Text style={[styles.registrationSectionHint, { color: colors.mutedForeground }]}>You’ll use this to approve transactions.</Text>
          </View>
          <Feather name="lock" size={18} color={colors.button} />
        </View>
        <View style={styles.registrationPinRow}>
          {[
            { label: '6-DIGIT PIN', value: pin, update: setPin, testID: 'registration-pin' },
            { label: 'CONFIRM PIN', value: confirmPin, update: setConfirmPin, testID: 'registration-confirm-pin' },
          ].map((field) => (
            <View key={field.label} style={styles.registrationPinField}>
              <Text style={[styles.registrationFieldLabel, { color: colors.mutedForeground }]}>{field.label}</Text>
              <View style={[styles.registrationInputShell, styles.registrationPinInputShell, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  value={field.value}
                  onChangeText={(value) => { field.update(value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
                  placeholder="6 digits"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="number-pad"
                  secureTextEntry={!showPin}
                  maxLength={6}
                  style={[styles.registrationInput, styles.registrationPinInput, { color: colors.foreground }]}
                  testID={field.testID}
                />
                <HapticPressable onPress={() => setShowPin((visible) => !visible)} style={styles.pinVisibilityButton}>
                  <Feather name={showPin ? 'eye-off' : 'eye'} size={17} color={colors.mutedForeground} />
                </HapticPressable>
              </View>
            </View>
          ))}
        </View>
      </View>
      {error ? (
        <View style={[styles.registrationError, { backgroundColor: colors.destructive + '12' }]}>
          <Feather name="alert-circle" size={17} color={colors.destructive} />
          <Text style={[styles.registrationErrorText, { color: colors.destructive }]}>{error}</Text>
        </View>
      ) : null}
      <HapticPressable onPress={() => void submit()} style={[styles.registrationSubmitButton, { backgroundColor: colors.button }]}>
        <Feather name="shield" size={18} color={colors.buttonForeground} />
        <Text style={[styles.registrationSubmitText, { color: colors.buttonForeground }]}>Create account</Text>
        <Feather name="arrow-right" size={18} color={colors.buttonForeground} />
      </HapticPressable>
      <HapticPressable onPress={onBack} style={styles.biometricButton} testID="goto-login">
        <Feather name="log-in" size={17} color={colors.primary} />
        <Text style={[styles.biometricText, { color: colors.primary }]}>Already have an account? Log in</Text>
      </HapticPressable>
      <View style={[styles.registrationNoteCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name="info" size={16} color={colors.mutedForeground} />
        <Text style={[styles.registrationNote, { color: colors.mutedForeground }]}>
          Pilot notice: your account, PIN and bank preference are stored on the pilot server. All balances are test money: cash-outs and top-ups are simulated, and no real money moves.
        </Text>
      </View>
      <HapticPressable onPress={() => void enterDemoMode()} style={styles.biometricButton} testID="enter-demo">
        <Feather name="play-circle" size={17} color={colors.foreground} />
        <Text style={[styles.biometricText, { color: colors.foreground }]}>Explore the demo instead</Text>
      </HapticPressable>
      <Text style={[styles.demoHint, { color: colors.mutedForeground }]}>
        The demo uses prepared dummy profiles and test money on this device only. No real details are collected.
      </Text>
    </ScrollView>
  );
}

function Header({
  title,
  subtitle,
  online,
  onSettings,
}: {
  title: string;
  subtitle: string;
  online: boolean;
  onSettings: () => void;
}) {
  const { demoMode } = useWallet();
  return (
    <View style={styles.header}>
      <View style={styles.headerIdentity}>
        <View style={styles.headerLogoCircle}>
          <LogoIcon size={28} />
        </View>
        <View>
          <Text style={styles.headerTitleOnTeal}>{title}</Text>
          <Text style={styles.headerSubtitleOnTeal}>{subtitle}</Text>
        </View>
      </View>
      <View style={styles.headerActions}>
        {demoMode ? (
          <View style={[styles.statusPill, { backgroundColor: 'rgba(255,255,255,0.18)' }]} testID="demo-badge">
            <Text style={[styles.statusText, { color: '#FFE1B3' }]}>DEMO</Text>
          </View>
        ) : null}
        <View style={[styles.statusPill, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
          <View style={[styles.statusDot, { backgroundColor: online ? '#8FCB81' : '#FCD34D' }]} />
          <Text style={[styles.statusText, { color: '#FFFFFF' }]}>
            {online ? 'Online' : 'Offline'}
          </Text>
        </View>
        <HapticPressable onPress={onSettings} style={styles.headerSettingsButton} testID="open-settings">
          <Feather name="sliders" size={18} color="#FFFFFF" />
        </HapticPressable>
      </View>
    </View>
  );
}

function BalanceCard({ balance, online, label }: { balance: number; online: boolean; label: string }) {
  const colors = useColors();
  const { demoMode } = useWallet();
  const [hidden, setHidden] = useState(false);
  return (
    <View style={styles.balanceCardWhite}>
      <View style={styles.balanceTop}>
        <Text style={[styles.balanceLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <HapticPressable onPress={() => setHidden((value) => !value)} style={styles.balanceVisibility}>
          <Feather name={hidden ? 'eye-off' : 'eye'} size={17} color={colors.mutedForeground} />
        </HapticPressable>
      </View>
      <Text style={[styles.balanceAmountDark, { color: colors.foreground }]}>{hidden ? '••••••' : zar(balance)}</Text>
      <View style={styles.balanceBottom}>
        <Text style={[styles.balanceFoot, { color: colors.mutedForeground }]}>{online ? 'Available balance · ZAR' : 'Cached balance - may be out of date'}</Text>
        <View style={[styles.secureBadgeLight, { backgroundColor: colors.accent }]}>
          <Feather name="shield" size={12} color={colors.accentForeground} />
          <Text style={[styles.secureBadgeTextLight, { color: colors.accentForeground }]}>{demoMode ? 'Local demo' : online ? 'Test money' : 'Cached copy'}</Text>
        </View>
      </View>
    </View>
  );
}

function ActivityRow({ transaction, colors }: { transaction: Transaction; colors: ReturnType<typeof useColors> }) {
  const icon: IconName =
    transaction.kind === 'VAS_ELEC'
      ? 'zap'
      : transaction.kind === 'VAS_AIRTIME'
        ? 'phone'
        : transaction.kind === 'CASH_OUT'
          ? 'download'
          : transaction.kind === 'TOP_UP'
            ? 'plus-circle'
            : 'arrow-down-left';
  const tint = transaction.status === 'PENDING SYNC' ? colors.warning : transaction.direction === 'in' ? colors.success : colors.foreground;
  return (
    <View style={styles.activityRow}>
      <View style={[styles.activityIcon, { backgroundColor: transaction.status === 'PENDING SYNC' ? colors.warm : colors.muted }]}>
        <Feather name={icon} size={17} color={tint} />
      </View>
      <View style={styles.activityCopy}>
        <Text style={[styles.activityTitle, { color: colors.foreground }]}>{transaction.title}</Text>
        <Text style={[styles.activitySubtitle, { color: colors.mutedForeground }]}>{transaction.subtitle}</Text>
      </View>
      <View style={styles.activityValue}>
        <Text style={[styles.activityAmount, { color: tint }]}>
          {transaction.direction === 'in' ? '+' : '-'}{zar(transaction.amount)}
        </Text>
        <View style={[styles.miniStatus, { backgroundColor: transaction.status === 'PENDING SYNC' ? colors.warm : colors.accent }]}>
          <Text style={[styles.miniStatusText, { color: transaction.status === 'PENDING SYNC' ? colors.warning : colors.accentForeground }]}>
            {transaction.status === 'PENDING SYNC' ? 'Pending' : 'Success'}
          </Text>
        </View>
      </View>
    </View>
  );
}

function QuickAction({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <HapticPressable onPress={onPress} style={styles.quickAction}>
      <View style={[styles.quickIcon, { backgroundColor: colors.accent }]}>
        <Feather name={icon} size={20} color={colors.accentForeground} />
      </View>
      <Text style={[styles.quickLabel, { color: colors.foreground }]}>{label}</Text>
    </HapticPressable>
  );
}

function BankPicker({ selectedId, onSelect }: { selectedId: string | null; onSelect: (bank: SaBank) => void }) {
  const colors = useColors();
  return (
    <View style={styles.providerGrid}>
      {saBanks.map((bank) => {
        const selected = selectedId === bank.id;
        return (
          <HapticPressable key={bank.id} onPress={() => onSelect(bank)} style={[styles.providerTile, { backgroundColor: selected ? colors.accent : colors.card, borderColor: selected ? colors.primary : colors.border }]}>
            <View style={[styles.providerCheck, styles.providerTileCheck, selected ? { backgroundColor: colors.primary } : { borderWidth: 1, borderColor: colors.border }]}>
              {selected ? <Feather name="check" size={11} color={colors.primaryForeground} /> : null}
            </View>
            <View style={styles.providerTileLogoFrame}>
              <Image source={{ uri: bank.logo }} style={styles.providerTileLogo} resizeMode="contain" />
            </View>
            <Text style={[styles.providerTileName, { color: colors.foreground }]}>{bank.name}</Text>
          </HapticPressable>
        );
      })}
    </View>
  );
}

function BankCard({
  bank,
  accountNumber,
  accountType,
  label,
  onChange,
}: {
  bank?: SaBank;
  accountNumber?: string;
  accountType?: string;
  label: string;
  onChange?: () => void;
}) {
  const colors = useColors();
  if (!bank) return null;
  return (
    <View style={[styles.bankCard, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      <View style={[styles.bankCardLogoFrame, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Image source={{ uri: bank.logo }} style={styles.bankCardLogo} resizeMode="contain" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.bankCardLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.bankCardName, { color: colors.foreground }]}>{bank.name}</Text>
        <Text style={[styles.bankCardMeta, { color: colors.mutedForeground }]}>{[accountType, maskAccount(accountNumber)].filter(Boolean).join(' · ')}</Text>
      </View>
      {onChange ? (
        <HapticPressable onPress={onChange} style={styles.bankCardChange}>
          <Text style={[styles.bankCardChangeText, { color: colors.primary }]}>Change</Text>
        </HapticPressable>
      ) : null}
    </View>
  );
}

function HomeScreen({
  onNavigate,
  onOpenCashOut,
  onOpenTopUp,
}: {
  onNavigate: (screen: Screen) => void;
  onOpenCashOut: () => void;
  onOpenTopUp: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { buyerBalance, merchantBalance, online, toggleOnline, transactions, profile, lastSyncedAt, demoMode } = useWallet();
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: 124 }}
    >
      <LinearGradient
        colors={['#211A12', '#3A2E1A']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.homeBand, { paddingTop: insets.top + 18 }]}
      >
        <Header
          title={profile.name}
          subtitle={profile.accountType === 'business' ? profile.businessCategory ?? 'Informal business' : 'Individual wallet'}
          online={online}
          onSettings={() => onNavigate('settings')}
        />
        <BalanceCard
          balance={profile.accountType === 'business' ? merchantBalance : buyerBalance}
          online={online}
          label={profile.accountType === 'business' ? 'BUSINESS WALLET' : 'PERSONAL WALLET'}
        />
      </LinearGradient>
      <View style={styles.homeBody}>
      {profile.accountType === 'business' ? (
        <HapticPressable onPress={() => onNavigate('scan')} style={[styles.scanCta, { backgroundColor: colors.button }]}>
          <View style={styles.scanCtaCopy}>
            <Text style={[styles.scanCtaEyebrow, { color: colors.buttonForeground }]}>GET PAID</Text>
            <Text style={[styles.scanCtaTitle, { color: colors.buttonForeground }]}>Scan customer QR</Text>
            <Text style={[styles.scanCtaText, { color: colors.buttonForeground }]}>Your customer shows a one-time QR. You scan once.</Text>
          </View>
          <View style={[styles.scanCtaIcon, { backgroundColor: colors.buttonForeground }]}>
            <Feather name="maximize" size={25} color={colors.button} />
          </View>
        </HapticPressable>
      ) : (
        <HapticPressable onPress={() => onNavigate('pay')} style={[styles.scanCta, { backgroundColor: colors.button }]}>
          <View style={styles.scanCtaCopy}>
            <Text style={[styles.scanCtaEyebrow, { color: colors.buttonForeground }]}>PAY A TRADER</Text>
            <Text style={[styles.scanCtaTitle, { color: colors.buttonForeground }]}>Pay with QR</Text>
            <Text style={[styles.scanCtaText, { color: colors.buttonForeground }]}>Create a one-time QR. The trader scans it to get paid.</Text>
          </View>
          <View style={[styles.scanCtaIcon, { backgroundColor: colors.buttonForeground }]}>
            <Feather name="credit-card" size={25} color={colors.button} />
          </View>
        </HapticPressable>
      )}
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Quick actions</Text>
        <Text style={[styles.sectionHint, { color: colors.mutedForeground }]}>Tap to start</Text>
      </View>
      <View style={styles.actionGrid}>
        {profile.accountType === 'business' ? (
          <>
            <QuickAction icon="zap" label="Sell VAS" onPress={() => onNavigate('vas')} />
            <QuickAction icon="credit-card" label="Customer pays" onPress={() => onNavigate('pay')} />
            <QuickAction icon="plus-circle" label="Top up" onPress={onOpenTopUp} />
            <QuickAction icon="download" label="Cash out" onPress={onOpenCashOut} />
          </>
        ) : (
          <>
            <QuickAction icon="credit-card" label="Pay a trader" onPress={() => onNavigate('pay')} />
            <QuickAction icon="plus-circle" label="Top up" onPress={onOpenTopUp} />
          </>
        )}
      </View>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent activity</Text>
        <HapticPressable onPress={() => onNavigate('activity')}>
          <Text style={[styles.sectionLink, { color: colors.mutedForeground }]}>See all</Text>
        </HapticPressable>
      </View>
      <View style={[styles.activityCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {transactions.slice(0, 5).map((transaction) => (
          <ActivityRow key={transaction.id} transaction={transaction} colors={colors} />
        ))}
      </View>
      {!online ? (
        <View style={[styles.offlineBanner, { backgroundColor: colors.warm }]}>
          <Feather name="wifi-off" size={17} color={colors.warning} />
          <View style={styles.offlineCopy}>
            <Text style={[styles.offlineTitle, { color: colors.foreground }]}>You’re offline</Text>
            <Text style={[styles.offlineText, { color: colors.mutedForeground }]}>
              {demoMode
                ? 'You’re offline — the local demo keeps working; these balances live on this device only.'
                : lastSyncedAt
                  ? `Balances last synced ${formatSyncedAt(lastSyncedAt)} and may be out of date. Payments are unavailable until you reconnect.`
                  : 'Balances shown may be out of date. Payments are unavailable until you reconnect.'}
            </Text>
          </View>
        </View>
      ) : null}
      </View>
    </ScrollView>
  );
}

function Keypad({ value, onDigit, onBackspace }: { value: string; onDigit: (digit: string) => void; onBackspace: () => void }) {
  const colors = useColors();
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
  return (
    <View style={styles.amountKeypad}>
      {keys.map((key) => (
        <HapticPressable
          key={key}
          onPress={() => (key === 'back' ? onBackspace() : onDigit(key))}
          style={styles.amountKey}
        >
          {key === 'back' ? <Feather name="delete" size={21} color={colors.foreground} /> : <Text style={[styles.amountKeyText, { color: colors.foreground }]}>{key}</Text>}
        </HapticPressable>
      ))}
    </View>
  );
}

function QRCode({ payload }: { payload: QrPayload }) {
  const colors = useColors();
  const value = encodeQrPayload(payload);
  return (
    <View style={[styles.qrFrame, { backgroundColor: '#FFFFFF', borderColor: colors.border }]}>
      <QRCodeSvg
        value={value}
        size={210}
        color="#0A0A0A"
        backgroundColor="#FFFFFF"
        quietZone={6}
        ecl="Q"
        logo={logoMark}
        logoSize={36}
        logoBackgroundColor="#FFFFFF"
        logoBorderRadius={8}
      />
    </View>
  );
}

function PayScreen({ onBack }: { onBack: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { buyerBalance, createPaymentRequest, paymentRequest, completePayment, profile, demoMode } = useWallet();
  const [amount, setAmount] = useState('');
  const [qrVisible, setQrVisible] = useState(false);
  const [seconds, setSeconds] = useState(60);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pendingAmount, setPendingAmount] = useState(0);
  const [localPaymentRequest, setLocalPaymentRequest] = useState<PaymentRequest | null>(null);
  const [pinError, setPinError] = useState('');

  useEffect(() => {
    if (!qrVisible) return;
    const timer = setInterval(() => setSeconds((value) => (value <= 1 ? 0 : value - 1)), 1000);
    return () => clearInterval(timer);
  }, [qrVisible]);

  useEffect(() => {
    if (seconds === 0) setQrVisible(false);
  }, [seconds]);

  const number = Number(amount);
  const generate = () => {
    if (number <= 0 || number > buyerBalance) return;
    setPendingAmount(number);
    setPinModalVisible(true);
  };

  const handlePinConfirm = async (enteredPin: string) => {
    const request = await createPaymentRequest(pendingAmount, enteredPin);
    if (request !== null) {
      setLocalPaymentRequest(request);
      setSeconds(60);
      setQrVisible(true);
      setPinModalVisible(false);
      setPinError('');
    } else {
      setPinError('Could not create the payment request. Check your PIN and connection.');
    }
  };

  const activeRequest = localPaymentRequest ?? paymentRequest;
  const qrPayload: QrPayload | null = activeRequest
    ? buildQrPayload(activeRequest, profile.name)
    : null;

  return (
    <ScrollView
      style={[styles.screenRoot, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 18, paddingBottom: insets.bottom + 120 }}
      showsVerticalScrollIndicator={false}
      bounces={false}
    >
      <View style={styles.pageHeader}>
        <HapticPressable onPress={onBack} style={styles.backButton}>
          <Feather name="arrow-left" size={21} color={colors.foreground} />
        </HapticPressable>
        <View>
          <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>CUSTOMER MODE</Text>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>Pay with QR</Text>
        </View>
        <View style={{ width: 42 }} />
      </View>
      <View style={[styles.payBalance, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>CUSTOMER BALANCE</Text>
          <Text style={[styles.payBalanceAmount, { color: colors.foreground }]}>{zar(buyerBalance)}</Text>
        </View>
        <View style={[styles.payBalanceIcon, { backgroundColor: colors.accent }]}>
          <Feather name="credit-card" size={18} color={colors.accentForeground} />
        </View>
      </View>
      <View style={styles.amountHeader}>
        <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>YOU PAY</Text>
        <Text style={[styles.amountDisplay, { color: number > buyerBalance ? colors.destructive : colors.foreground }]}>
          {amount ? `R${amount}` : 'R0.00'}
        </Text>
        {number > buyerBalance ? <Text style={[styles.validationText, { color: colors.destructive }]}>Amount exceeds available balance</Text> : null}
      </View>
      <View style={styles.quickAmounts}>
        {[20, 35, 50, 100].map((quick) => (
          <HapticPressable key={quick} onPress={() => setAmount(String(quick))} style={[styles.quickAmount, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <Text style={[styles.quickAmountText, { color: colors.foreground }]}>R{quick}</Text>
          </HapticPressable>
        ))}
      </View>
      <Keypad value={amount} onDigit={(digit) => setAmount((current) => (current.length < 7 ? `${current}${digit}` : current))} onBackspace={() => setAmount((current) => current.slice(0, -1))} />
      <HapticPressable
        testID="generate-payment-qr"
        disabled={number <= 0 || number > buyerBalance}
        onPress={generate}
        style={[styles.primaryButton, styles.payCta, { backgroundColor: colors.button }]}
      >
        <Feather name="maximize" size={18} color={colors.buttonForeground} />
        <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>Show QR to seller</Text>
      </HapticPressable>
      <Text style={[styles.payCtaHint, { color: colors.mutedForeground }]}>The seller scans your code. It works once, for 60 seconds.</Text>
      <Modal visible={qrVisible} transparent animationType="fade" onRequestClose={() => setQrVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.qrModal, { backgroundColor: colors.card }]}>
            <View style={styles.qrModalHeader}>
              <View>
                <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>PAYMENT REQUEST</Text>
                <Text style={[styles.qrModalTitle, { color: colors.foreground }]}>{zar(activeRequest?.amount ?? number)}</Text>
              </View>
              <HapticPressable onPress={() => setQrVisible(false)} style={styles.closeButton}>
                <Feather name="x" size={20} color={colors.foreground} />
              </HapticPressable>
            </View>
            {qrPayload ? (
              <QRCode payload={qrPayload} />
            ) : (
              <View style={[styles.qrFrame, { backgroundColor: colors.card, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', height: 218 }]}>
                <Text style={[styles.tokenText, { color: colors.mutedForeground }]}>No request generated</Text>
              </View>
            )}
            <View style={[styles.timerPill, { backgroundColor: colors.warm }]}>
              <Feather name="clock" size={15} color={colors.warning} />
              <Text style={[styles.timerText, { color: colors.warning }]}>{seconds}s remaining</Text>
            </View>
            <Text style={[styles.qrInstruction, { color: colors.mutedForeground }]}>
              {demoMode
                ? "Test money only. The trader's app verifies this code in the local demo on this device; no real money moves."
                : "Test money only. The trader's app verifies this code on the pilot server; no real money moves."}
            </Text>
            <Text style={[styles.tokenText, { color: colors.mutedForeground }]}>{activeRequest?.token ?? 'tok_demo_pm'}</Text>
          </View>
        </View>
      </Modal>
       <PinConfirmationModal
        visible={pinModalVisible}
        onConfirm={handlePinConfirm}
        onCancel={() => setPinModalVisible(false)}
        title="Confirm Payment"
        summary={`Create a ${zar(pendingAmount)} payment request`}
        error={pinError}
        onClearError={() => setPinError('')}
      />
    </ScrollView>
  );
}

function ScanScreen({ onBack, onNavigate }: { onBack: () => void; onNavigate: (screen: Screen) => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { completePayment, previewPaymentRequest, verifyReceipt, online, demoMode } = useWallet();

  const [permissionResponse, requestPermission] = useCameraPermissions();
  const [asked, setAsked] = useState(false);
  const [result, setResult] = useState<'idle' | 'success' | 'failed' | 'unknown' | 'unconfirmed'>('idle');
  const [failureMessage, setFailureMessage] = useState('');
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [unknownMessage, setUnknownMessage] = useState('');
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinError, setPinError] = useState('');
  const [scannedPayload, setScannedPayload] = useState<QrPayload | null>(null);
  const [preview, setPreview] = useState<PaymentRequestPreview | null>(null);
  const [scanned, setScanned] = useState(false);
  const [scanError, setScanError] = useState('');
  const [cameraError, setCameraError] = useState(false);
  const cameraContainerRef = useRef<View>(null);
  const webDetectorRef = useRef<WebQrDetector | null>(null);
  const cameraGranted = !!permissionResponse?.granted && !cameraError;

  useEffect(() => {
    // Native platforms request the camera permission up front. On web the
    // permission is requested on demand (via the "Enable camera" button) so the
    // scanner never surprises users with a permission prompt.
    if (Platform.OS === 'web' || asked) return;
    setAsked(true);
    void requestPermission();
  }, [asked]);

  const resetScan = () => {
    setScannedPayload(null);
    setPreview(null);
    setScanned(false);
    setScanError('');
    setCameraError(false);
  };

  // Test-only scaffolding: ?scantest=<token> injects a scanned payload so the
  // accept/recovery journey can be exercised without a camera. Inert for
  // anyone who does not pass the parameter; the token goes through the exact
  // same server verification and PIN confirmation as a camera scan.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const fixtureToken = new URLSearchParams(window.location.search).get('scantest');
    if (!fixtureToken || fixtureToken.length > 128) return;
    setScanned(true);
    void processPayload({ token: fixtureToken, amount: 0, expiresAt: Date.now() + 60_000, name: 'Test fixture' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Web runs its own detection loop (see WebQrDetector above): it polls the
  // camera <video>, uses native BarcodeDetector where available and the
  // bundled ZXing fallback elsewhere, and surfaces a visible error when a
  // browser can do neither - instead of expo-camera's web shim, which
  // swallows every detector error and delivers an event shape the handler
  // does not expect.
  useEffect(() => {
    if (Platform.OS !== 'web' || !cameraGranted || scanned) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detector = webDetectorRef.current ?? new WebQrDetector();
    webDetectorRef.current = detector;
    const tick = async () => {
      if (cancelled) return;
      try {
        const node = cameraContainerRef.current as unknown as {
          querySelector?: (selector: string) => HTMLVideoElement | null;
        } | null;
        const video = node?.querySelector?.('video') ?? null;
        if (video && video.readyState >= 2) {
          const text = await detector.detect(video);
          if (text && !cancelled) handleBarcodeScanned({ data: text });
          if (!cancelled && detector.unavailable) {
            setScanError('This browser cannot scan QR codes. Try the latest Chrome.');
          }
        }
      } catch {
        // A single failed frame must never stop the scan loop.
      }
      if (!cancelled) timer = setTimeout(tick, 350);
    };
    timer = setTimeout(tick, 350);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraGranted, scanned]);

  const processPayload = async (payload: QrPayload) => {
    if (payload.expiresAt <= Date.now()) {
      setScanError('This QR has expired.');
      setScanned(false);
      return;
    }
    // The QR only carries the token. Amount and payer always come from the
    // pilot server, so a tampered or replayed QR cannot misstate the payment.
    const serverPreview = await previewPaymentRequest(payload.token);
    if (!serverPreview) {
      setScanError('Could not verify this payment request. Check your connection.');
      setScanned(false);
      return;
    }
    if (serverPreview.status === 'EXPIRED' || serverPreview.expiresAt <= Date.now()) {
      setScanError('This QR has expired. Ask the customer to create a new one.');
      setScanned(false);
      return;
    }
    if (serverPreview.status !== 'OPEN') {
      setScanError('This QR code has already been used.');
      setScanned(false);
      return;
    }
    setScannedPayload(payload);
    setPreview(serverPreview);
    setScanError('');
    setPinModalVisible(true);
  };

  const handleBarcodeScanned = (scanningResult: { data?: string; nativeEvent?: { data?: string } }) => {
    if (scanned) return;
    // Native expo-camera delivers { data }; its web shim wraps the same result
    // as { nativeEvent: { data } }. Accept both so a detected code is never
    // mistaken for a foreign one.
    const data = scanningResult?.data ?? scanningResult?.nativeEvent?.data ?? '';
    const payload = decodeQrPayload(data);
    if (!payload) {
      setScanError('That is not a Paymerch QR code.');
      return;
    }
    setScanned(true);
    void processPayload(payload).catch(() => {
      setScanned(false);
      setScanError('Could not verify this payment request. Check your connection.');
    });
  };

  const handlePinConfirm = async (enteredPin: string) => {
    if (!scannedPayload) return;
    if (!online) {
      setPinModalVisible(false);
      resetScan();
      setScanError('You are offline. Reconnect before accepting a payment.');
      return;
    }
    const outcome = await completePayment(scannedPayload, preview?.payerName ?? '', enteredPin);
    if (outcome === 'SUCCESS') {
      setResult('success');
      setPinModalVisible(false);
      setPinError('');
    } else if (outcome === 'INVALID_AUTH') {
      setPinError('Invalid PIN. Please try again.');
    } else if (outcome === 'ALREADY_USED') {
      // ALREADY_USED proves the token was claimed, not that THIS wallet was
      // paid - our own earlier attempt may have settled, or another merchant
      // may have claimed it. Only our own ledger entry is receipt proof.
      setPinModalVisible(false);
      setPinError('');
      const receipt = await verifyReceipt(scannedPayload.token, preview?.amount ?? 0);
      if (receipt === 'RECEIVED') {
        setResult('success');
      } else if (receipt === 'NOT_RECEIVED') {
        setResult('unconfirmed');
      } else {
        setUnknownMessage('');
        setResult('unknown');
      }
    } else if (outcome === 'UNKNOWN') {
      // The settlement answer was lost: the payment may or may not have
      // landed. Keep the scanned request and let the merchant check the
      // server's record before believing anything.
      setPinModalVisible(false);
      setPinError('');
      setUnknownMessage('');
      setResult('unknown');
    } else {
      const messages = {
        INVALID_REQUEST: 'This QR payment request is invalid.',
        EXPIRED: 'This QR has expired. Ask the customer to create a new one.',
        INSUFFICIENT_BALANCE: 'The customer does not have enough test money for this payment.',
      } as const;
      setPinModalVisible(false);
      setPinError('');
      setScannedPayload(null);
      setScanned(false);
      setFailureMessage(messages[outcome]);
      setResult('failed');
    }
  };

  if (result === 'success') {
    return (
      <View style={[styles.successRoot, { backgroundColor: colors.background, paddingTop: insets.top + 18 }]}>
        <View style={[styles.successMark, { backgroundColor: colors.button }]}>
          <Feather name="check" size={38} color="#211A12" />
        </View>
        <Text style={[styles.successKicker, { color: colors.mutedForeground }]}>TEST PAYMENT RECEIVED</Text>
        {preview ? <Text style={[styles.successAmount, { color: colors.foreground }]}>{zar(preview.amount)}</Text> : null}
        {preview ? (
          <Text style={[styles.successFrom, { color: colors.mutedForeground }]}>
            From {preview.payerName} · <Text style={{ color: colors.success, fontFamily: 'Montserrat_600SemiBold' }}>Completed · test money</Text>
          </Text>
        ) : null}
        <Text style={[styles.successSubtitle, { color: colors.mutedForeground }]}>
          {demoMode
            ? "Test money moved from the customer's wallet to your business wallet in the local demo on this device. No real money moved."
            : "Test money moved from the customer's wallet to your business wallet on the pilot server. No real money moved."}
          {"\n\n"}Your proof is the confirmed transaction in your own app - never a screen someone shows you.
        </Text>
        <HapticPressable onPress={() => onNavigate('home')} style={[styles.primaryButton, styles.resultButton, { backgroundColor: colors.button }]}>
          <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>Done</Text>
        </HapticPressable>
        <HapticPressable
          onPress={() => {
            setResult('idle');
            resetScan();
          }}
          style={styles.textButton}
        >
          <Text style={[styles.textButtonLabel, { color: colors.foreground }]}>Scan another payment</Text>
        </HapticPressable>
      </View>
    );
  }

  // Status check after a lost settlement answer. The token is single-use and
  // the server claim is atomic, so checking and (when still open) retrying
  // can never charge the customer twice.
  const checkUnknownStatus = async () => {
    if (!scannedPayload || checkingStatus) return;
    setCheckingStatus(true);
    setUnknownMessage('');
    const statusPreview = await previewPaymentRequest(scannedPayload.token);
    setCheckingStatus(false);
    if (!statusPreview) {
      setUnknownMessage('Still cannot reach the pilot server. Check Recent activity before taking this payment again.');
      return;
    }
    if (statusPreview.status === 'COMPLETED') {
      // COMPLETED means claimed by someone; confirm it landed in THIS wallet.
      const receipt = await verifyReceipt(scannedPayload.token, statusPreview.amount);
      if (receipt === 'RECEIVED') {
        setPreview(statusPreview);
        setResult('success');
      } else if (receipt === 'NOT_RECEIVED') {
        setResult('unconfirmed');
      } else {
        setUnknownMessage('Still cannot reach the pilot server. Check Recent activity before taking this payment again.');
      }
      return;
    }
    if (statusPreview.status === 'OPEN') {
      setUnknownMessage('');
      setPinModalVisible(true);
      return;
    }
    setResult('failed');
    setFailureMessage(
      statusPreview.status === 'EXPIRED'
        ? 'This QR has expired. Ask the customer to create a new one.'
        : 'This payment has already been completed. Check Recent activity.',
    );
  };

  if (result === 'unknown') {
    return (
      <View style={[styles.successRoot, { backgroundColor: colors.background, paddingTop: insets.top + 18 }]}>
        <View style={[styles.successMark, { backgroundColor: colors.warm }]}>
          <Feather name="wifi-off" size={34} color={colors.warning} />
        </View>
        <Text style={[styles.successKicker, { color: colors.mutedForeground }]}>CONNECTION DROPPED</Text>
        <Text style={[styles.successTitle, { color: colors.foreground }]}>Not confirmed yet</Text>
        <Text style={[styles.successSubtitle, { color: colors.mutedForeground }]}>
          {preview ? `${zar(preview.amount)} from ${preview.payerName}: ` : ''}the connection was lost before the pilot server answered. The payment may still have gone through - check before asking the customer to pay again.
        </Text>
        {unknownMessage ? (
          <Text style={[styles.successSubtitle, { color: colors.warning }]}>{unknownMessage}</Text>
        ) : null}
        <HapticPressable
          disabled={checkingStatus}
          onPress={() => void checkUnknownStatus()}
          style={[styles.primaryButton, styles.resultButton, { backgroundColor: colors.button, opacity: checkingStatus ? 0.6 : 1 }]}
        >
          <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>{checkingStatus ? 'Checking…' : 'Check status now'}</Text>
        </HapticPressable>
        <HapticPressable onPress={() => onNavigate('home')} style={styles.textButton}>
          <Text style={[styles.textButtonLabel, { color: colors.foreground }]}>View recent activity</Text>
        </HapticPressable>
        <HapticPressable
          onPress={() => {
            setResult('idle');
            resetScan();
          }}
          style={styles.textButton}
        >
          <Text style={[styles.textButtonLabel, { color: colors.mutedForeground }]}>Back to scanner</Text>
        </HapticPressable>
      </View>
    );
  }

  // The server says the token was claimed but this wallet shows no matching
  // receipt. Reconcile - never suggest taking the payment again.
  if (result === 'unconfirmed') {
    return (
      <View style={[styles.successRoot, { backgroundColor: colors.background, paddingTop: insets.top + 18 }]}>
        <View style={[styles.successMark, { backgroundColor: colors.warm }]}>
          <Feather name="search" size={34} color={colors.warning} />
        </View>
        <Text style={[styles.successKicker, { color: colors.mutedForeground }]}>NEEDS A MANUAL CHECK</Text>
        <Text style={[styles.successTitle, { color: colors.foreground }]}>Not confirmed in your wallet</Text>
        <Text style={[styles.successSubtitle, { color: colors.mutedForeground }]}>
          The pilot server shows this payment as completed, but no matching payment is in your recent activity. Ask the customer to open their activity to see who they paid, and check your own recent activity together before anyone pays again.
        </Text>
        <HapticPressable onPress={() => onNavigate('home')} style={[styles.primaryButton, styles.resultButton, { backgroundColor: colors.button }]}>
          <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>View recent activity</Text>
        </HapticPressable>
        <HapticPressable
          onPress={() => {
            setResult('idle');
            resetScan();
          }}
          style={styles.textButton}
        >
          <Text style={[styles.textButtonLabel, { color: colors.mutedForeground }]}>Back to scanner</Text>
        </HapticPressable>
      </View>
    );
  }

  if (result === 'failed') {
    return (
      <View style={[styles.successRoot, { backgroundColor: colors.background, paddingTop: insets.top + 18 }]}>
        <View style={[styles.successMark, { backgroundColor: colors.warm }]}>
          <Feather name="alert-triangle" size={34} color={colors.warning} />
        </View>
        <Text style={[styles.successTitle, { color: colors.foreground }]}>Payment failed</Text>
        <Text style={[styles.successSubtitle, { color: colors.mutedForeground }]}>{failureMessage}</Text>
        <HapticPressable
          onPress={() => {
            setResult('idle');
            resetScan();
          }}
          style={[styles.primaryButton, styles.resultButton, { backgroundColor: colors.button }]}
        >
          <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>Try again</Text>
        </HapticPressable>
        <HapticPressable onPress={() => onNavigate('home')} style={styles.textButton}>
          <Text style={[styles.textButtonLabel, { color: colors.foreground }]}>Back to dashboard</Text>
        </HapticPressable>
      </View>
    );
  }

  const canUseCamera = permissionResponse?.granted && !cameraError;
  const cameraStatus = cameraError
    ? 'Could not start the camera. Check camera access and try again.'
    : !permissionResponse?.granted
      ? 'Allow camera access to scan a customer QR code.'
      : 'Point your camera at an active Paymerch demo QR code.';

  return (
    <View style={[styles.scannerRoot, { backgroundColor: colors.dark, paddingTop: insets.top + 18, paddingBottom: insets.bottom + 18 }]}>
      <View style={styles.scannerHeader}>
        <HapticPressable onPress={onBack} style={styles.scannerBack}>
          <Feather name="arrow-left" size={21} color="#FFFFFF" />
        </HapticPressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.scannerEyebrow}>SELLER MODE</Text>
          <Text style={styles.scannerTitle} numberOfLines={1}>Scan customer QR</Text>
        </View>
        <StatusPill online={online} colors={colors} />
      </View>

      <View style={[styles.viewfinder, { height: canUseCamera ? 280 : 300, marginTop: 40 }]}>
        {canUseCamera ? (
          <View ref={cameraContainerRef} style={StyleSheet.absoluteFill}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              // On web, expo-camera's shim never reports detector errors and
              // wraps results as { nativeEvent }; the WebQrDetector loop above
              // handles web scanning instead.
              onBarcodeScanned={Platform.OS === 'web' || scanned ? undefined : handleBarcodeScanned}
              onMountError={() => setCameraError(true)}
              onCameraReady={() => {
                setCameraError(false);
              }}
            />
          </View>
        ) : null}
        <View style={[styles.corner, styles.cornerTopLeft]} />
        <View style={[styles.corner, styles.cornerTopRight]} />
        <View style={[styles.corner, styles.cornerBottomLeft]} />
        <View style={[styles.corner, styles.cornerBottomRight]} />
        <View style={styles.scanLine} />
        <View style={styles.viewfinderCenter}>
          <Feather name="maximize" size={34} color="rgba(255,255,255,0.75)" />
        </View>
        {scanError ? (
          <View style={styles.scanErrorPill}>
            <Feather name="alert-circle" size={14} color={colors.warning} />
            <Text style={[styles.scannerSubhint, { color: colors.warning }]}>{scanError}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.scannerCopy}>
        <Text style={styles.scannerHint}>
          {preview ? 'Customer payment detected' : canUseCamera ? 'Scan a customer payment QR' : 'Live QR scanner'}
        </Text>
        <Text style={styles.scannerSubhint}>
          {preview ? `${zar(preview.amount)} · ${preview.payerName}` : cameraStatus}
        </Text>
      </View>

      {!canUseCamera && (
        <HapticPressable
          onPress={() => {
            setCameraError(false);
            void requestPermission();
          }}
          style={[styles.scanDemoButton, { backgroundColor: colors.muted, marginTop: 8 }]}
        >
          <Feather name="camera" size={18} color={colors.foreground} />
          <Text style={[styles.scanDemoText, { color: colors.foreground }]}>
            {permissionResponse?.granted ? 'Retry camera' : 'Enable camera'}
          </Text>
        </HapticPressable>
      )}
      <Text style={styles.scannerFootnote}>
        {canUseCamera
          ? demoMode
            ? 'Test money only: the local demo on this device verifies the one-time QR and updates both wallets.'
            : 'Test money only: the pilot server verifies the one-time QR and updates both wallets.'
          : 'Payments can only be collected by scanning a valid, unexpired Paymerch QR.'}
      </Text>
      <PinConfirmationModal
        visible={pinModalVisible}
        onConfirm={handlePinConfirm}
        onCancel={() => {
          setPinModalVisible(false);
          if (!scanned) resetScan();
        }}
        title="Confirm Payment"
        summary={preview ? `Accept ${zar(preview.amount)} from ${preview.payerName}` : undefined}
        error={pinError}
        onClearError={() => setPinError('')}
      />
    </View>
  );
}

function VasScreen({ onBack }: { onBack: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { buyerBalance, vendVas } = useWallet();
  const [kind, setKind] = useState<'VAS_ELEC' | 'VAS_AIRTIME'>('VAS_ELEC');
  const [providerId, setProviderId] = useState<string>('eskom');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState(50);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const options = kind === 'VAS_ELEC' ? [20, 50, 100, 200] : [10, 20, 50, 100];
  const provider = kind === 'VAS_ELEC'
    ? eskomProvider
    : airtimeProviders.find((item) => item.id === providerId) ?? airtimeProviders[0];

  const vend = () => {
    if (kind === 'VAS_ELEC') {
      if (!destination.trim() || amount > buyerBalance) {
        setError('Add a meter number and choose an amount within your balance.');
        return;
      }
    } else if (kind === 'VAS_AIRTIME') {
      if (!destination.trim() || amount > buyerBalance) {
        setError('Add a valid phone number and choose an amount within your balance.');
        return;
      }
    }
    setPinModalVisible(true);
  };

  const handlePinConfirm = (_enteredPin: string) => {
    const result = vendVas(kind, amount, destination);
    if (result === 'INVALID_PIN') {
      setError('Invalid PIN. Please try again.');
      return;
    }
    if (result === null) {
      setError('Invalid details. Please check your input.');
      return;
    }
    if (kind === 'VAS_ELEC' && result !== 'SUCCESS') {
      setToken(result);
      setError('');
    } else if (kind === 'VAS_AIRTIME' && result === 'SUCCESS') {
      setToken('airtime');
      setError('');
    }
    setPinModalVisible(false);
  };

  if (token) {
    return (
      <View style={[styles.screenRoot, { backgroundColor: colors.background, paddingTop: insets.top + 18, paddingBottom: insets.bottom + 18 }]}>
        <View style={styles.pageHeader}>
          <HapticPressable onPress={onBack} style={styles.backButton}>
            <Feather name="arrow-left" size={21} color={colors.foreground} />
          </HapticPressable>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>VAS receipt</Text>
          <View style={{ width: 42 }} />
        </View>
        <View style={[styles.receiptCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.receiptMark, { backgroundColor: colors.accent }]}>
            <Feather name="check" size={25} color={colors.success} />
          </View>
          <Text style={[styles.receiptTitle, { color: colors.foreground }]}>{kind === 'VAS_ELEC' ? 'Electricity token ready' : 'Airtime sent'}</Text>
          <Text style={[styles.receiptSub, { color: colors.mutedForeground }]}>{kind === 'VAS_ELEC' ? 'Give this 20-digit token to the customer.' : `Airtime sent to ${destination}`}</Text>
          {kind === 'VAS_ELEC' ? (
            <View style={[styles.tokenBox, { backgroundColor: colors.muted }]}>
              <Text style={[styles.tokenValue, { color: colors.foreground }]}>{token.match(/.{1,4}/g)?.join(' ')}</Text>
              <Text style={[styles.tokenCaption, { color: colors.mutedForeground }]}>ESKOM · STS TOKEN · R{amount}</Text>
            </View>
          ) : (
            <View style={[styles.tokenBox, { backgroundColor: colors.muted }]}>
              <Text style={[styles.tokenValue, { color: colors.foreground }]}>R{amount}.00</Text>
              <Text style={[styles.tokenCaption, { color: colors.mutedForeground }]}>{provider.name.toUpperCase()} AIRTIME</Text>
            </View>
          )}
          <HapticPressable onPress={() => setToken(null)} style={[styles.primaryButton, { backgroundColor: colors.button }]}>
            <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>Vend another</Text>
          </HapticPressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 112 }]}>
      <View style={styles.pageHeader}>
        <HapticPressable onPress={onBack} style={styles.backButton}>
          <Feather name="arrow-left" size={21} color={colors.foreground} />
        </HapticPressable>
        <View>
          <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>VALUE-ADDED SERVICES</Text>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>Sell VAS</Text>
        </View>
        <View style={{ width: 42 }} />
      </View>
      <Text style={[styles.formLabel, { color: colors.foreground }]}>Electricity</Text>
      <HapticPressable onPress={() => { setKind('VAS_ELEC'); setProviderId('eskom'); setError(''); }} style={[styles.providerWide, { backgroundColor: kind === 'VAS_ELEC' ? colors.accent : colors.card, borderColor: kind === 'VAS_ELEC' ? colors.primary : colors.border }]}>
        <View style={styles.providerLogoFrame}>
          <Image source={{ uri: eskomProvider.logo }} style={styles.providerLogo} resizeMode="contain" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.providerName, { color: colors.foreground }]}>Eskom prepaid</Text>
          <Text style={[styles.providerHint, { color: colors.mutedForeground }]}>STS electricity token</Text>
        </View>
        <View style={[styles.providerCheck, kind === 'VAS_ELEC' ? { backgroundColor: colors.primary } : { borderWidth: 1, borderColor: colors.border }]}>
          {kind === 'VAS_ELEC' ? <Feather name="check" size={13} color={colors.primaryForeground} /> : null}
        </View>
      </HapticPressable>
      <Text style={[styles.formLabel, { color: colors.foreground, marginTop: 22 }]}>Airtime & data</Text>
      <View style={styles.providerGrid}>
        {airtimeProviders.map((item) => {
          const selected = kind === 'VAS_AIRTIME' && providerId === item.id;
          return (
            <HapticPressable key={item.id} onPress={() => { setKind('VAS_AIRTIME'); setProviderId(item.id); setError(''); }} style={[styles.providerTile, { backgroundColor: selected ? colors.accent : colors.card, borderColor: selected ? colors.primary : colors.border }]}>
              <View style={[styles.providerCheck, styles.providerTileCheck, selected ? { backgroundColor: colors.primary } : { borderWidth: 1, borderColor: colors.border }]}>
                {selected ? <Feather name="check" size={11} color={colors.primaryForeground} /> : null}
              </View>
              <View style={styles.providerTileLogoFrame}>
                <Image source={{ uri: item.logo }} style={styles.providerTileLogo} resizeMode="contain" />
              </View>
              <Text style={[styles.providerTileName, { color: colors.foreground }]}>{item.name}</Text>
            </HapticPressable>
          );
        })}
      </View>
      <Text style={[styles.formLabel, { color: colors.foreground, marginTop: 22 }]}>{kind === 'VAS_ELEC' ? 'Meter number' : `${provider.name} phone number`}</Text>
      <TextInput
        value={destination}
        onChangeText={(value) => { setDestination(value); setError(''); }}
        placeholder={kind === 'VAS_ELEC' ? 'e.g. 1234 5678 9012' : 'e.g. 082 123 4567'}
        placeholderTextColor={colors.mutedForeground}
        keyboardType="phone-pad"
        style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
      />
      <View style={styles.vasAmountHeader}>
        <Text style={[styles.formLabel, { color: colors.foreground }]}>Choose value</Text>
        <Text style={[styles.balanceHint, { color: colors.mutedForeground }]}>Wallet {zar(buyerBalance)}</Text>
      </View>
      <View style={styles.vasOptions}>
        {options.map((option) => (
          <HapticPressable key={option} onPress={() => setAmount(option)} style={[styles.vasOption, { backgroundColor: amount === option ? colors.foreground : colors.card, borderColor: amount === option ? colors.foreground : colors.border }]}>
            <Text style={[styles.vasOptionText, { color: amount === option ? '#F8F1E2' : colors.foreground }]}>R{option}</Text>
          </HapticPressable>
        ))}
      </View>
      {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}
      <HapticPressable disabled style={[styles.primaryButton, { backgroundColor: colors.button, marginTop: 28, opacity: 0.5 }]}>
        <Feather name={kind === 'VAS_ELEC' ? 'zap' : 'phone'} size={18} color={colors.buttonForeground} />
        <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>{kind === 'VAS_ELEC' ? 'Generate electricity token' : `Send ${provider.name} airtime`}</Text>
      </HapticPressable>
      <View style={[styles.infoBanner, { backgroundColor: colors.accent }]}>
        <Feather name="info" size={16} color={colors.accentForeground} />
        <Text style={[styles.infoText, { color: colors.accentForeground }]}>Demo preview: VAS vending is not part of this pilot build yet, and no provider accounts are connected. Airtime and electricity return in a later stage.</Text>
      </View>
      <PinConfirmationModal
        visible={pinModalVisible}
        onConfirm={handlePinConfirm}
        onCancel={() => setPinModalVisible(false)}
        title="Confirm VAS Transaction"
        error={error}
        onClearError={() => setError('')}
      />
    </ScrollView>
  );
}

function ActivityScreen({ onBack }: { onBack: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { transactions } = useWallet();
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.pageHeader}>
        <HapticPressable onPress={onBack} style={styles.backButton}>
          <Feather name="arrow-left" size={21} color={colors.foreground} />
        </HapticPressable>
        <View>
          <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>WALLET</Text>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>Activity</Text>
        </View>
        <View style={{ width: 42 }} />
      </View>
      <View style={[styles.activityCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {transactions.map((transaction) => (
          <ActivityRow key={transaction.id} transaction={transaction} colors={colors} />
        ))}
      </View>
    </ScrollView>
  );
}

function SettingsScreen({ onBack }: { onBack: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { online, toggleOnline, syncPending, transactions, logout, businessCategory, setBusinessCategory, profile, demoMode, switchDemoProfile, exitDemoMode, lastSyncedAt } = useWallet();
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 30 }]}>
      <View style={styles.pageHeader}>
        <HapticPressable onPress={onBack} style={styles.backButton}>
          <Feather name="arrow-left" size={21} color={colors.foreground} />
        </HapticPressable>
        <View>
          <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>ACCOUNT</Text>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>Settings</Text>
        </View>
        <View style={{ width: 42 }} />
      </View>
      <View style={[styles.settingsProfile, { backgroundColor: colors.dark }]}>
        <View style={styles.profileInitials}><Text style={styles.profileInitialText}>{initialsFor(profile.name)}</Text></View>
        <View>
          <Text style={styles.settingsName}>{profile.name}</Text>
          <Text style={styles.settingsPhone}>{profile.phone}</Text>
        </View>
      </View>
      {profile.bankName ? (
        <>
          <Text style={[styles.formLabel, { color: colors.mutedForeground }]}>BANK</Text>
          <BankCard
            bank={findBank(profile.bankName)}
            accountNumber={profile.bankAccountNumber}
            accountType={profile.bankAccountType}
            label={profile.accountType === 'business' ? 'CASH-OUT DESTINATION (DEMO)' : 'TOP-UP SOURCE (DEMO)'}
          />
        </>
      ) : null}
      {demoMode ? (
        <>
          <Text style={[styles.formLabel, { color: colors.mutedForeground }]}>DEMO MODE</Text>
          <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.settingRow}>
              <View style={[styles.settingIcon, { backgroundColor: colors.warm }]}><Feather name="play-circle" size={17} color={colors.warning} /></View>
              <View style={styles.settingCopy}>
                <Text style={[styles.settingTitle, { color: colors.foreground }]}>Demo mode is on</Text>
                <Text style={[styles.settingSubtitle, { color: colors.mutedForeground }]}>Prepared dummy profiles. Test money on this device only.</Text>
              </View>
            </View>
            <HapticPressable onPress={() => void switchDemoProfile()} style={[styles.syncButton, { backgroundColor: colors.muted }]} testID="switch-demo-profile">
              <Feather name="repeat" size={15} color={colors.foreground} />
              <Text style={[styles.syncButtonText, { color: colors.foreground }]}>Switch to {profile.accountType === 'business' ? 'Demo Buyer' : 'Demo Trader'}</Text>
            </HapticPressable>
            <HapticPressable onPress={() => void exitDemoMode()} style={[styles.syncButton, { backgroundColor: colors.muted }]} testID="exit-demo">
              <Feather name="log-out" size={15} color={colors.foreground} />
              <Text style={[styles.syncButtonText, { color: colors.foreground }]}>Exit demo</Text>
            </HapticPressable>
          </View>
        </>
      ) : null}
      {profile.accountType === 'business' ? (
        <>
          <Text style={[styles.formLabel, { color: colors.mutedForeground }]}>BUSINESS TYPE</Text>
          <View style={[styles.categoryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.categoryIntro, { color: colors.mutedForeground }]}>Choose the business you run. Paymerch works for everyday informal trade.</Text>
            <View style={styles.categoryGrid}>
              {businessCategories.map((category) => {
                const selected = businessCategory === category;
                return (
                  <HapticPressable
                    key={category}
                    onPress={() => setBusinessCategory(category)}
                    style={[styles.categoryChip, { backgroundColor: selected ? colors.active : colors.muted, borderColor: selected ? colors.active : colors.border }]}
                  >
                    <Text style={[styles.categoryChipText, { color: selected ? colors.activeForeground : colors.foreground }]}>{category}</Text>
                  </HapticPressable>
                );
              })}
            </View>
          </View>
        </>
      ) : (
        <View style={[styles.individualNote, { backgroundColor: colors.muted }]}>
          <Feather name="user" size={16} color={colors.mutedForeground} />
          <Text style={[styles.individualNoteText, { color: colors.mutedForeground }]}>Individual wallet selected. You can receive, send, and manage everyday payments without registering a business.</Text>
        </View>
      )}
      <Text style={[styles.formLabel, { color: colors.mutedForeground }]}>CONNECTION</Text>
      <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.settingRow}>
          <View style={[styles.settingIcon, { backgroundColor: online ? colors.accent : colors.warm }]}>
            <Feather name={online ? 'wifi' : 'wifi-off'} size={17} color={online ? colors.accentForeground : colors.warning} />
          </View>
          <View style={styles.settingCopy}>
            <Text style={[styles.settingTitle, { color: colors.foreground }]}>{online ? 'Connected' : 'Offline'}</Text>
            <Text style={[styles.settingSubtitle, { color: colors.mutedForeground }]}>
              {demoMode
                ? 'Local demo · balances stored on this device'
                : online
                  ? `Balances synced${lastSyncedAt ? ` ${formatSyncedAt(lastSyncedAt)}` : ''}`
                  : lastSyncedAt
                    ? `Last synced ${formatSyncedAt(lastSyncedAt)} · payments unavailable`
                    : 'Balances may be out of date · payments unavailable'}
            </Text>
          </View>
          <HapticPressable onPress={toggleOnline} style={[styles.toggle, { backgroundColor: online ? colors.success : colors.border }]}>
            <View style={[styles.toggleThumb, { backgroundColor: colors.card, alignSelf: online ? 'flex-end' : 'flex-start' }]} />
          </HapticPressable>
        </View>
        {!online ? (
          <HapticPressable onPress={() => { if (!online) toggleOnline(); syncPending(); }} style={[styles.syncButton, { backgroundColor: colors.muted }]}>
            <Feather name="refresh-cw" size={15} color={colors.foreground} />
            <Text style={[styles.syncButtonText, { color: colors.foreground }]}>Retry connection now</Text>
          </HapticPressable>
        ) : null}
      </View>
      <Text style={[styles.formLabel, { color: colors.mutedForeground }]}>SECURITY</Text>
      <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.settingRow}>
          <View style={[styles.settingIcon, { backgroundColor: colors.muted }]}><Feather name="shield" size={17} color={colors.foreground} /></View>
          <View style={styles.settingCopy}>
            <Text style={[styles.settingTitle, { color: colors.foreground }]}>Device protected</Text>
            <Text style={[styles.settingSubtitle, { color: colors.mutedForeground }]}>PIN and secure storage are active</Text>
          </View>
          <Feather name="check-circle" size={20} color={colors.success} />
        </View>
      </View>
      <View style={[styles.settingsNote, { backgroundColor: colors.muted }]}>
        <Feather name="info" size={16} color={colors.mutedForeground} />
        <Text style={[styles.settingsNoteText, { color: colors.mutedForeground }]}>{demoMode
          ? 'Demo mode stores this profile, bank preference and test balances on this device only. Cash-outs and top-ups are simulated in the local demo, not real bank payouts or debits.'
          : 'This pilot stores accounts, bank preferences and test balances on the pilot server. Cash-outs and top-ups are simulated ledger entries, not real bank payouts or debits.'}</Text>
      </View>
      <HapticPressable onPress={() => void logout()} style={[styles.logoutButton, { borderColor: colors.border }]}>
        <Feather name="log-out" size={17} color={colors.destructive} />
        <Text style={[styles.logoutText, { color: colors.destructive }]}>Lock wallet</Text>
      </HapticPressable>
    </ScrollView>
  );
}

function BottomNav({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Screen) => void }) {
  const colors = useColors();
  const items: { key: Screen; label: string; icon: IconName }[] = [
    { key: 'home', label: 'Home', icon: 'home' },
    { key: 'pay', label: 'Pay', icon: 'credit-card' },
    { key: 'scan', label: 'Scan', icon: 'maximize' },
    { key: 'vas', label: 'VAS', icon: 'zap' },
  ];
  return (
    <View style={[styles.bottomNav, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: Platform.OS === 'web' ? 34 : 10 }]}>
      {items.map((item) => {
        const active = screen === item.key;
        return (
          <HapticPressable key={item.key} onPress={() => onNavigate(item.key)} style={styles.navItem}>
            <View style={[styles.navIcon, active && { backgroundColor: colors.button }]}>
              <Feather name={item.icon} size={18} color={active ? colors.buttonForeground : colors.mutedForeground} />
            </View>
            <Text style={[styles.navLabel, { color: active ? colors.foreground : colors.mutedForeground }]}>{item.label}</Text>
          </HapticPressable>
        );
      })}
    </View>
  );
}

export default function PaymerchHome() {
  const { ready, signedIn, isRegistered } = useWallet();
  const [screen, setScreen] = useState<Screen>('home');
  const [cashOutVisible, setCashOutVisible] = useState(false);
  const [cashOutAmount, setCashOutAmount] = useState('100');
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [cashOutError, setCashOutError] = useState('');
  const [topUpVisible, setTopUpVisible] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState('100');
  const [topUpPinModalVisible, setTopUpPinModalVisible] = useState(false);
  const [topUpError, setTopUpError] = useState('');
  const [cashOutBankId, setCashOutBankId] = useState<string | null>(null);
  const [cashOutBankPicker, setCashOutBankPicker] = useState(false);
  const [topUpBankId, setTopUpBankId] = useState<string | null>(null);
  const [topUpBankPicker, setTopUpBankPicker] = useState(false);
  const [splashAcknowledged, setSplashAcknowledged] = useState(false);
  const [authEntryMode, setAuthEntryMode] = useState<'login' | 'register' | undefined>(undefined);
  const [installPrompt, setInstallPrompt] = useState<DeferredInstallPrompt | null>(null);
  const colors = useColors();
  const { cashOut, topUp, merchantBalance, buyerBalance, profile, enterDemoMode, demoMode } = useWallet();

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as DeferredInstallPrompt);
    };
    const handleAppInstalled = () => setInstallPrompt(null);

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const handleCashOutPinConfirm = async (enteredPin: string) => {
    if (await cashOut(Number(cashOutAmount), enteredPin)) {
      setCashOutVisible(false);
      setPinModalVisible(false);
      setCashOutError('');
    } else {
      setCashOutError('Invalid PIN. Please try again.');
    }
  };

  const handleTopUpPinConfirm = async (enteredPin: string) => {
    if (await topUp(Number(topUpAmount), enteredPin)) {
      setTopUpVisible(false);
      setTopUpPinModalVisible(false);
      setTopUpError('');
    } else {
      setTopUpError('Invalid PIN. Please try again.');
    }
  };

  if (!splashAcknowledged || !ready) {
    return (
      <AppSplashScreen
        onRegister={() => {
          // Devices already holding an account keep the PIN-pad landing; the
          // register intent only applies when no local profile exists.
          setAuthEntryMode(isRegistered ? undefined : 'register');
          setSplashAcknowledged(true);
        }}
        onLogin={() => {
          setAuthEntryMode('login');
          setSplashAcknowledged(true);
        }}
        onInstall={installPrompt ? () => void installApp() : undefined}
        onWatchDemo={() => {
          setAuthEntryMode(undefined);
          setSplashAcknowledged(true);
          void enterDemoMode();
        }}
      />
    );
  }
  if (!signedIn) return <AuthScreen initialAuthMode={authEntryMode} />;

  const navigate = (next: Screen) => {
    setCashOutVisible(false);
    setScreen(next);
  };

  const renderScreen = () => {
    if (screen === 'pay') return <PayScreen onBack={() => navigate('home')} />;
    if (screen === 'scan') return <ScanScreen onBack={() => navigate('home')} onNavigate={navigate} />;
    if (screen === 'vas') return <VasScreen onBack={() => navigate('home')} />;
    if (screen === 'activity') return <ActivityScreen onBack={() => navigate('home')} />;
    if (screen === 'settings') return <SettingsScreen onBack={() => navigate('home')} />;
    return <HomeScreen onNavigate={navigate} onOpenCashOut={() => setCashOutVisible(true)} onOpenTopUp={() => setTopUpVisible(true)} />;
  };

  const mainContent = (
    <View style={styles.appRoot}>
      {renderScreen()}
      {['home', 'pay', 'vas'].includes(screen) ? <BottomNav screen={screen} onNavigate={navigate} /> : null}
      <Modal visible={cashOutVisible} transparent animationType="slide" onRequestClose={() => setCashOutVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.cashOutModal, { backgroundColor: colors.card }]}>
            <ScrollView showsVerticalScrollIndicator={false} bounces={false} keyboardShouldPersistTaps="handled">
              <View style={styles.qrModalHeader}>
                <View>
                  <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>BUSINESS WALLET · {zar(merchantBalance)}</Text>
                  <Text style={[styles.qrModalTitle, { color: colors.foreground }]}>Cash out</Text>
                </View>
                <HapticPressable onPress={() => setCashOutVisible(false)} style={styles.closeButton}><Feather name="x" size={20} color={colors.foreground} /></HapticPressable>
              </View>
              <Text style={[styles.formLabel, { color: colors.foreground }]}>PAYOUT TO</Text>
              {(() => {
                const destination = cashOutBankId ? saBanks.find((bank) => bank.id === cashOutBankId) : findBank(profile.bankName);
                return destination ? (
                  <BankCard
                    bank={destination}
                    accountNumber={cashOutBankId ? undefined : profile.bankAccountNumber}
                    accountType={cashOutBankId ? undefined : profile.bankAccountType}
                    label={cashOutBankId ? 'DEMO DESTINATION' : 'YOUR BANK (DEMO)'}
                    onChange={() => setCashOutBankPicker((open) => !open)}
                  />
                ) : null;
              })()}
              {cashOutBankPicker || (!profile.bankName && !cashOutBankId) ? (
                <View style={{ marginTop: cashOutBankPicker ? 10 : 0 }}>
                  <BankPicker selectedId={cashOutBankId} onSelect={(bank) => { setCashOutBankId(bank.id); setCashOutBankPicker(false); }} />
                </View>
              ) : null}
              <Text style={[styles.formLabel, { color: colors.foreground, marginTop: 16 }]}>AMOUNT</Text>
              <TextInput value={cashOutAmount} onChangeText={setCashOutAmount} keyboardType="decimal-pad" style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />
              <View style={[styles.cashOutBankNote, { backgroundColor: colors.warm }]}>
                <Feather name="info" size={15} color={colors.warning} />
                <Text style={[styles.cashOutBankNoteText, { color: colors.foreground }]}>
                  {demoMode
                    ? 'Test cash-out only: it updates the business wallet balance in the local demo on this device. The bank shown is where a payout would go in production - no real payout happens.'
                    : 'Test cash-out only: it updates the business wallet balance on the pilot server. The bank shown is where a payout would go in production - no real payout happens.'}
                </Text>
              </View>
              <HapticPressable
                onPress={() => {
                  setPinModalVisible(true);
                }}
                disabled={Number(cashOutAmount) <= 0 || Number(cashOutAmount) > merchantBalance || (!profile.bankName && !cashOutBankId)}
                style={[styles.primaryButton, { backgroundColor: colors.button, marginTop: 18 }]}
              >
                <Feather name="download" size={18} color={colors.buttonForeground} />
                <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>Confirm cash out</Text>
              </HapticPressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
      <PinConfirmationModal
        visible={pinModalVisible}
        onConfirm={handleCashOutPinConfirm}
        onCancel={() => setPinModalVisible(false)}
        title="Confirm Cash Out"
        summary={`Cash out ${zar(Number(cashOutAmount) || 0)} from your business wallet (test only)`}
        error={cashOutError}
        onClearError={() => setCashOutError('')}
      />
      <Modal visible={topUpVisible} transparent animationType="slide" onRequestClose={() => setTopUpVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.cashOutModal, { backgroundColor: colors.card }]}>
            <ScrollView showsVerticalScrollIndicator={false} bounces={false} keyboardShouldPersistTaps="handled">
              <View style={styles.qrModalHeader}>
                <View>
                  <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>{profile.accountType === 'business' ? 'BUSINESS WALLET' : 'PERSONAL WALLET'} · {zar(profile.accountType === 'business' ? merchantBalance : buyerBalance)}</Text>
                  <Text style={[styles.qrModalTitle, { color: colors.foreground }]}>Top up wallet</Text>
                </View>
                <HapticPressable onPress={() => setTopUpVisible(false)} style={styles.closeButton}><Feather name="x" size={20} color={colors.foreground} /></HapticPressable>
              </View>
              <Text style={[styles.formLabel, { color: colors.foreground }]}>FROM</Text>
              {(() => {
                const source = topUpBankId ? saBanks.find((bank) => bank.id === topUpBankId) : findBank(profile.bankName);
                return source ? (
                  <BankCard
                    bank={source}
                    accountNumber={topUpBankId ? undefined : profile.bankAccountNumber}
                    accountType={topUpBankId ? undefined : profile.bankAccountType}
                    label={topUpBankId ? 'DEMO SOURCE' : 'YOUR BANK (DEMO)'}
                    onChange={() => setTopUpBankPicker((open) => !open)}
                  />
                ) : null;
              })()}
              {topUpBankPicker || (!profile.bankName && !topUpBankId) ? (
                <View style={{ marginTop: topUpBankPicker ? 10 : 0 }}>
                  <BankPicker selectedId={topUpBankId} onSelect={(bank) => { setTopUpBankId(bank.id); setTopUpBankPicker(false); }} />
                </View>
              ) : null}
              <Text style={[styles.formLabel, { color: colors.foreground, marginTop: 16 }]}>AMOUNT</Text>
              <View style={styles.vasOptions}>
                {[50, 100, 200, 500].map((option) => (
                  <HapticPressable key={option} onPress={() => setTopUpAmount(String(option))} style={[styles.vasOption, { backgroundColor: Number(topUpAmount) === option ? colors.foreground : colors.card, borderColor: Number(topUpAmount) === option ? colors.foreground : colors.border }]}>
                    <Text style={[styles.vasOptionText, { color: Number(topUpAmount) === option ? '#F8F1E2' : colors.foreground }]}>R{option}</Text>
                  </HapticPressable>
                ))}
              </View>
              <TextInput value={topUpAmount} onChangeText={setTopUpAmount} keyboardType="decimal-pad" placeholder="Custom amount" placeholderTextColor={colors.mutedForeground} style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, marginTop: 12 }]} />
              <View style={[styles.cashOutBankNote, { backgroundColor: colors.warm }]}>
                <Feather name="info" size={15} color={colors.warning} />
                <Text style={[styles.cashOutBankNoteText, { color: colors.foreground }]}>
                  {demoMode
                    ? 'Test top-up only: it adds test money to your demo wallet on this device. The bank shown is where a debit would come from in production - no real money moves.'
                    : 'Test top-up only: it adds test money to your pilot wallet on the pilot server. The bank shown is where a debit would come from in production - no real money moves.'}
                </Text>
              </View>
              <HapticPressable
                onPress={() => {
                  setTopUpPinModalVisible(true);
                }}
                disabled={Number(topUpAmount) <= 0 || Number(topUpAmount) > 50000 || (!profile.bankName && !topUpBankId)}
                style={[styles.primaryButton, { backgroundColor: colors.button, marginTop: 18 }]}
              >
                <Feather name="plus-circle" size={18} color={colors.buttonForeground} />
                <Text style={[styles.primaryButtonText, { color: colors.buttonForeground }]}>Confirm top up</Text>
              </HapticPressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
      <PinConfirmationModal
        visible={topUpPinModalVisible}
        onConfirm={handleTopUpPinConfirm}
        onCancel={() => setTopUpPinModalVisible(false)}
        title="Confirm Top Up"
        summary={`Top up ${zar(Number(topUpAmount) || 0)} into your ${profile.accountType === 'business' ? 'business' : 'personal'} wallet (test only)`}
        error={topUpError}
        onClearError={() => setTopUpError('')}
      />
    </View>
  );

  // Add web container for proper centering on web
  if (Platform.OS === 'web') {
    return (
      <View style={styles.webContainer}>
        {mainContent}
      </View>
    );
  }

  return mainContent;
}

const styles = StyleSheet.create({
  appRoot: { flex: 1, maxWidth: 480, alignSelf: 'center', width: '100%' },
  webContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4EDDC' },
  loadingRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { fontFamily: 'Montserrat_500Medium', fontSize: 14 },
  splashScroll: { flex: 1, width: '100%' },
  splashRoot: { flexGrow: 1, alignItems: 'stretch', justifyContent: 'space-between', gap: 24, paddingHorizontal: 24, width: '100%', maxWidth: 480, alignSelf: 'center' },
  splashRootCompact: { gap: 14 },
  splashHero: { alignItems: 'center', width: '100%' },
  splashHeroCompact: { flexShrink: 0 },
  splashArtwork: { width: 224, height: 204, alignItems: 'center', justifyContent: 'center', position: 'relative', marginBottom: 22 },
  splashArtworkCompact: { height: 148, marginBottom: 12 },
  splashOrb: { position: 'absolute', width: 190, height: 190, borderRadius: 95, opacity: 0.8 },
  splashOrbCompact: { width: 140, height: 140, borderRadius: 70 },
  splashOrbInner: { width: 150, height: 150, borderRadius: 75, alignItems: 'center', justifyContent: 'center', shadowColor: '#053D3D', shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  splashOrbInnerCompact: { width: 116, height: 116, borderRadius: 58 },
  splashEyebrow: { fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.6, textAlign: 'center' },
  splashDescription: { fontFamily: 'Montserrat_400Regular', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10, maxWidth: 330 },
  splashFooter: { gap: 17 },
  splashFooterCompact: { gap: 10 },
  splashFeatures: { flexDirection: 'row', gap: 8 },
  splashFeature: { flex: 1, minHeight: 66, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 3 },
  splashFeatureCompact: { minHeight: 54, gap: 4, paddingVertical: 6 },
  splashFeatureText: { fontFamily: 'Montserrat_500Medium', fontSize: 10, textAlign: 'center' },
  splashAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 999, minHeight: 54, paddingHorizontal: 20, alignSelf: 'stretch' },
  splashActionCompact: { minHeight: 48 },
  splashActionText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 15 },
  splashInstallAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  splashInstallText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  splashSecurityNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 1 },
  splashSecurityText: { fontFamily: 'Montserrat_400Regular', fontSize: 11, textAlign: 'center' },
  authRoot: { flex: 1, width: '100%' },
  authScrollContent: { flexGrow: 1, justifyContent: 'space-between', maxWidth: 480, alignSelf: 'center', width: '100%' },
  authTop: { alignItems: 'center', paddingTop: 66, gap: 5, width: '100%' },
  brandName: { fontFamily: 'Montserrat_700Bold', fontSize: 16, letterSpacing: 3.4, textAlign: 'center' },
  tagline: { fontFamily: 'Montserrat_400Regular', fontSize: 13, textAlign: 'center' },
  authBody: { alignItems: 'center', width: '100%', marginTop: 20 },
  authEyebrow: { fontFamily: 'Montserrat_700Bold', fontSize: 11, letterSpacing: 1.6, textAlign: 'center' },
  authTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 28, marginTop: 8, textAlign: 'center' },
  authSubtitle: { fontFamily: 'Montserrat_400Regular', fontSize: 14, marginTop: 9, textAlign: 'center' },
  pinDots: { flexDirection: 'row', gap: 12, marginTop: 20, marginBottom: 10 },
  pinDot: { width: 10, height: 10, borderRadius: 5 },
  errorText: { fontFamily: 'Montserrat_500Medium', fontSize: 12, textAlign: 'center', marginTop: 7, maxWidth: 290 },
  registerLink: { padding: 10, marginTop: 5 },
  registerLinkText: { fontFamily: 'Montserrat_500Medium', fontSize: 12 },
  registrationRoot: { paddingHorizontal: 20, width: '100%', maxWidth: 520, alignSelf: 'center' },
  registrationHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 27 },
  registrationBackButton: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  registrationProgress: { flex: 1, alignItems: 'center', gap: 7 },
  registrationProgressTrack: { width: '100%', maxWidth: 160, height: 4, borderRadius: 2 },
  registrationProgressFill: { width: '100%', height: 4, borderRadius: 2 },
  registrationProgressText: { fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.3 },
  registrationIntro: { alignItems: 'flex-start', marginBottom: 28 },
  registrationEyebrow: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 7 },
  registrationTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 29, letterSpacing: -0.4, marginTop: 13 },
  registrationSubtitle: { fontFamily: 'Montserrat_400Regular', fontSize: 14, lineHeight: 20, marginTop: 7, maxWidth: 360 },
  registrationSection: { marginBottom: 13 },
  registrationSectionTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 15 },
  registrationSectionHint: { fontFamily: 'Montserrat_400Regular', fontSize: 12, lineHeight: 17, marginTop: 4 },
  accountTypeOptions: { flexDirection: 'row', gap: 10, marginBottom: 24 },
  accountTypeCard: { flex: 1, minHeight: 96, borderWidth: 1, borderRadius: 17, alignItems: 'flex-start', justifyContent: 'center', gap: 8, paddingHorizontal: 11, paddingVertical: 11 },
  accountTypeIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  accountTypeCopy: { alignSelf: 'stretch', paddingRight: 18 },
  accountTypeTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 13 },
  accountTypeDescription: { fontFamily: 'Montserrat_400Regular', fontSize: 10, lineHeight: 14, marginTop: 3 },
  selectionIndicator: { position: 'absolute', top: 11, right: 11, width: 19, height: 19, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  registrationFieldGroup: { marginBottom: 19 },
  registrationFieldLabel: { fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.1, marginBottom: 8 },
  registrationInputShell: { minHeight: 54, borderWidth: 1, borderRadius: 15, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14 },
  registrationInput: { flex: 1, minWidth: 0, minHeight: 50, paddingVertical: 0, fontFamily: 'Montserrat_400Regular', fontSize: 14 },
  bankSection: { borderWidth: 1, borderRadius: 19, padding: 14, marginBottom: 22 },
  bankSectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 19 },
  bankSectionIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  bankSectionCopy: { flex: 1 },
  bankSelector: { marginBottom: 17 },
  bankSelectorText: { flex: 1, fontFamily: 'Montserrat_500Medium', fontSize: 13 },
  bankFieldLabel: { marginTop: 15 },
  bankAccountTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  bankAccountTypeOption: { flexGrow: 1, minHeight: 40, borderWidth: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 7 },
  bankAccountTypeText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 10, textAlign: 'center' },
  bankFieldsRow: { flexDirection: 'row', gap: 9 },
  bankAccountNameField: { flex: 1, minWidth: 0 },
  bankBranchInput: { minHeight: 48 },
  bankTransferNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 12, padding: 10, marginTop: 14 },
  bankTransferNoticeText: { flex: 1, fontFamily: 'Montserrat_400Regular', fontSize: 10, lineHeight: 15 },
  bankPickerModal: { maxHeight: '84%', borderTopLeftRadius: 25, borderTopRightRadius: 25, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  bankPickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  bankSearchShell: { minHeight: 48 },
  bankList: { marginTop: 7 },
  bankOption: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  bankOptionIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  bankOptionText: { flex: 1, fontFamily: 'Montserrat_500Medium', fontSize: 13 },
  bankEmptyText: { fontFamily: 'Montserrat_400Regular', fontSize: 13, textAlign: 'center', paddingVertical: 28 },
  linkedBankCard: { borderWidth: 1, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 22 },
  linkedBankIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  linkedBankCopy: { flex: 1 },
  linkedBankName: { fontFamily: 'Montserrat_700Bold', fontSize: 13 },
  linkedBankMeta: { fontFamily: 'Montserrat_400Regular', fontSize: 10, marginTop: 4 },
  cashOutBankNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 13, padding: 11, marginTop: 14 },
  cashOutBankNoteText: { flex: 1, fontFamily: 'Montserrat_400Regular', fontSize: 11, lineHeight: 16 },
  registrationCategoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  registrationCategoryCard: { width: '48.5%', minHeight: 45, borderWidth: 1, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 9, paddingVertical: 8 },
  registrationCategoryText: { flex: 1, fontFamily: 'Montserrat_500Medium', fontSize: 11, lineHeight: 15 },
  registrationPinSection: { marginTop: 1 },
  registrationPinHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 },
  registrationPinRow: { flexDirection: 'row', gap: 10 },
  registrationPinField: { flex: 1 },
  registrationPinInputShell: { gap: 2, paddingHorizontal: 10 },
  registrationPinInput: { textAlign: 'center', fontSize: 13 },
  pinVisibilityButton: { width: 30, height: 38, alignItems: 'center', justifyContent: 'center' },
  registrationError: { flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 11, marginTop: 15 },
  registrationErrorText: { flex: 1, fontFamily: 'Montserrat_500Medium', fontSize: 12, lineHeight: 17 },
  registrationSubmitButton: { minHeight: 58, borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 19, marginTop: 23, shadowColor: '#6B4E0A', shadowOpacity: 0.17, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
  registrationSubmitText: { flex: 1, fontFamily: 'Montserrat_700Bold', fontSize: 15, textAlign: 'center' },
  registrationNoteCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderWidth: 1, borderRadius: 14, padding: 13, marginTop: 14 },
  registrationNote: { flex: 1, fontFamily: 'Montserrat_400Regular', fontSize: 11, lineHeight: 16 },
  pinPad: { width: '100%', maxWidth: 330, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12, marginTop: 6 },
  pinKey: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center' },
  pinKeyCircle: { borderRadius: 30 },
  pinKeyText: { fontFamily: 'Montserrat_500Medium', fontSize: 22 },
  scanErrorPill: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  biometricButton: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10, marginTop: 10 },
  biometricText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  demoHint: { fontFamily: 'Montserrat_400Regular', fontSize: 12, marginTop: 2 },
  secureFooter: { textAlign: 'center', fontFamily: 'Montserrat_400Regular', fontSize: 12, paddingBottom: 24, marginTop: 14 },
  scrollContent: { paddingHorizontal: 18 },
  screenRoot: { flex: 1, paddingHorizontal: 18 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerIdentity: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  headerTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 15 },
  headerSubtitle: { fontFamily: 'Montserrat_400Regular', fontSize: 12, marginTop: 3 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 20 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 11 },
  iconButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 17 },
  balanceCard: { borderRadius: 24, padding: 19, marginTop: 20, minHeight: 148 },
  balanceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  balanceLabel: { fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.2, color: '#A7A7A7' },
  balanceVisibility: { padding: 4 },
  balanceAmount: { fontFamily: 'Montserrat_700Bold', fontSize: 34, letterSpacing: -1.2, color: '#FFFFFF', marginTop: 19 },
  balanceBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 17 },
  balanceFoot: { fontFamily: 'Montserrat_400Regular', color: '#A7A7A7', fontSize: 12 },
  secureBadge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  secureBadgeText: { fontFamily: 'Montserrat_500Medium', color: '#A7F3D0', fontSize: 11 },
  pinSummary: { marginTop: 14, borderRadius: 13, paddingVertical: 11, paddingHorizontal: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 },
  pinSummaryText: { fontFamily: 'Montserrat_700Bold', fontSize: 15, textAlign: 'center' },
  pinModal: { borderRadius: 24, padding: 24, width: '90%', maxWidth: 360, alignSelf: 'center' },
  pinModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  pinModalTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 20, marginTop: 4 },
  scanCta: { borderRadius: 24, minHeight: 112, padding: 18, marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  scanCtaCopy: { flex: 1, minWidth: 0 },
  scanCtaEyebrow: { fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.1 },
  scanCtaTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 22, marginTop: 6 },
  scanCtaText: { fontFamily: 'Montserrat_400Regular', fontSize: 12, marginTop: 4 },
  scanCtaIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 25, marginBottom: 11 },
  sectionTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 16 },
  sectionHint: { fontFamily: 'Montserrat_400Regular', fontSize: 12 },
  sectionLink: { fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-start', marginTop: 4 },
  quickAction: { alignItems: 'center', gap: 8, minWidth: 72, paddingVertical: 4 },
  quickIcon: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  quickLabel: { fontFamily: 'Montserrat_600SemiBold', fontSize: 12, textAlign: 'center' },
  activityCard: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 14 },
  activityRow: { flexDirection: 'row', alignItems: 'center', minHeight: 73, borderBottomWidth: 1, borderBottomColor: '#F0F0ED' },
  activityIcon: { width: 37, height: 37, borderRadius: 18.5, alignItems: 'center', justifyContent: 'center' },
  activityCopy: { flex: 1, paddingLeft: 10 },
  activityTitle: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  activitySubtitle: { fontFamily: 'Montserrat_400Regular', fontSize: 11, marginTop: 4 },
  activityValue: { alignItems: 'flex-end', gap: 5 },
  activityAmount: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  miniStatus: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  miniStatusText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 9 },
  offlineBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, padding: 13, marginTop: 14 },
  offlineCopy: { flex: 1 },
  offlineTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 12 },
  offlineText: { fontFamily: 'Montserrat_400Regular', fontSize: 11, marginTop: 3, lineHeight: 16 },
  pageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 23 },
  backButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  pageEyebrow: { fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.3 },
  pageTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 25, marginTop: 4 },
  payBalance: { borderWidth: 1, borderRadius: 18, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.2 },
  payBalanceAmount: { fontFamily: 'Montserrat_700Bold', fontSize: 24, marginTop: 7 },
  payBalanceIcon: { width: 39, height: 39, borderRadius: 19.5, alignItems: 'center', justifyContent: 'center' },
  amountHeader: { alignItems: 'center', marginTop: 12 },
  amountDisplay: { fontFamily: 'Montserrat_700Bold', fontSize: 36, letterSpacing: -1, marginTop: 4 },
  validationText: { fontFamily: 'Montserrat_400Regular', fontSize: 11, marginTop: 3 },
  quickAmounts: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 10 },
  quickAmount: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  quickAmountText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  amountKeypad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 12 },
  amountKey: { width: '30%', height: 46, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  amountKeyText: { fontFamily: 'Montserrat_500Medium', fontSize: 24 },
  primaryButton: { minHeight: 53, borderRadius: 999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 },
  primaryButtonText: { fontFamily: 'Montserrat_700Bold', fontSize: 14 },
  payCta: { marginTop: 16 },
  payCtaHint: { fontFamily: 'Montserrat_400Regular', fontSize: 11, textAlign: 'center', marginTop: 10, paddingHorizontal: 30, lineHeight: 16 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.35 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.58)', justifyContent: 'flex-end' },
  qrModal: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 22, alignItems: 'center', minHeight: 500 },
  qrModalHeader: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  qrModalTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 30, marginTop: 4 },
  closeButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  qrFrame: { padding: 12, borderRadius: 18, borderWidth: 1 },
  qrGrid: { width: 210, height: 210, flexDirection: 'row', flexWrap: 'wrap' },
  qrCell: { width: 10, height: 10 },
  timerPill: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, marginTop: 16 },
  timerText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  qrInstruction: { fontFamily: 'Montserrat_400Regular', fontSize: 12, textAlign: 'center', lineHeight: 17, marginTop: 15, maxWidth: 280 },
  tokenText: { fontFamily: 'Montserrat_400Regular', fontSize: 9, marginTop: 9 },
  scannerRoot: { flex: 1, paddingHorizontal: 18 },
  scannerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  scannerBack: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  scannerEyebrow: { fontFamily: 'Montserrat_700Bold', color: '#8A8A8A', fontSize: 10, letterSpacing: 1.2 },
  scannerTitle: { fontFamily: 'Montserrat_700Bold', color: '#FFFFFF', fontSize: 20, marginTop: 4 },
  viewfinder: { height: 300, marginTop: 40, position: 'relative', alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', width: 48, height: 48, borderColor: '#FFFFFF' },
  cornerTopLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 14 },
  cornerTopRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 14 },
  cornerBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 14 },
  cornerBottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 14 },
  scanLine: { position: 'absolute', top: '49%', left: 28, right: 28, height: 2, backgroundColor: '#E9A820' },
  viewfinderCenter: { width: 80, height: 80, borderRadius: 26, borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)', alignItems: 'center', justifyContent: 'center' },
  scannerCopy: { alignItems: 'center', marginTop: 34 },
  scannerHint: { fontFamily: 'Montserrat_600SemiBold', color: '#FFFFFF', fontSize: 16 },
  scannerSubhint: { fontFamily: 'Montserrat_400Regular', color: '#999999', fontSize: 12, marginTop: 8, textAlign: 'center' },
  scanDemoButton: { minHeight: 54, borderRadius: 999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9, marginTop: 'auto' },
  scanDemoText: { fontFamily: 'Montserrat_700Bold', fontSize: 14 },
  scannerFootnote: { fontFamily: 'Montserrat_400Regular', color: '#777777', textAlign: 'center', fontSize: 11, marginTop: 12 },
  successRoot: { flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  successMark: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center' },
  successTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 26, marginTop: 20 },
  successKicker: { fontFamily: 'Montserrat_700Bold', fontSize: 12, letterSpacing: 1.4, marginTop: 18 },
  successAmount: { fontFamily: 'Montserrat_700Bold', fontSize: 44, letterSpacing: -1, marginTop: 6 },
  successFrom: { fontFamily: 'Montserrat_400Regular', fontSize: 14, marginTop: 6 },
  successSubtitle: { fontFamily: 'Montserrat_400Regular', textAlign: 'center', lineHeight: 20, fontSize: 14, marginTop: 10, maxWidth: 300 },
  textButton: { padding: 15, marginTop: 6 },
  textButtonLabel: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  segmented: { borderRadius: 999, padding: 4, flexDirection: 'row', marginBottom: 27, alignSelf: 'center', gap: 12 },
  segment: { flex: 1, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', paddingVertical: 11, borderRadius: 999 },
  segmentText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  formLabel: { fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.2, marginBottom: 9, textAlign: 'center' },
  textInput: { borderWidth: 1, borderRadius: 15, minHeight: 53, paddingHorizontal: 15, fontFamily: 'Montserrat_400Regular', fontSize: 14 },
  vasAmountHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 24 },
  providerWide: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 22, borderWidth: 1.5, padding: 12 },
  providerLogoFrame: { width: 56, height: 56, borderRadius: 16, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  providerLogo: { width: 44, height: 44 },
  providerName: { fontFamily: 'Montserrat_700Bold', fontSize: 15 },
  providerHint: { fontFamily: 'Montserrat_400Regular', fontSize: 12, marginTop: 2 },
  providerCheck: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  providerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  providerTile: { width: '31%', flexGrow: 1, borderRadius: 20, borderWidth: 1.5, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8 },
  providerTileCheck: { position: 'absolute', top: 8, right: 8 },
  providerTileLogoFrame: { width: 52, height: 52, borderRadius: 14, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  providerTileLogo: { width: 42, height: 42 },
  providerTileName: { fontFamily: 'Montserrat_700Bold', fontSize: 12, marginTop: 8 },
  balanceHint: { fontFamily: 'Montserrat_400Regular', fontSize: 12 },
  vasOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  vasOption: { width: '48%', minHeight: 54, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  vasOptionText: { fontFamily: 'Montserrat_700Bold', fontSize: 15 },
  infoBanner: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderRadius: 15, padding: 13, marginTop: 17 },
  infoText: { flex: 1, fontFamily: 'Montserrat_400Regular', fontSize: 11, lineHeight: 16 },
  receiptCard: { borderRadius: 22, borderWidth: 1, padding: 21, alignItems: 'center', marginTop: 30 },
  receiptMark: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center' },
  receiptTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 21, marginTop: 16 },
  receiptSub: { fontFamily: 'Montserrat_400Regular', textAlign: 'center', fontSize: 12, lineHeight: 17, marginTop: 7 },
  tokenBox: { width: '100%', borderRadius: 15, paddingVertical: 18, paddingHorizontal: 10, alignItems: 'center', marginTop: 22, marginBottom: 20 },
  tokenValue: { fontFamily: 'Montserrat_700Bold', fontSize: 20, letterSpacing: 1.4, textAlign: 'center' },
  tokenCaption: { fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1, marginTop: 8 },
  bottomNav: { position: 'absolute', bottom: 0, left: 0, right: 0, minHeight: 76, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingTop: 8 },
  navItem: { alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 58 },
  navIcon: { width: 44, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  navLabel: { fontFamily: 'Montserrat_600SemiBold', fontSize: 10 },
  cashOutModal: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 22, minHeight: 280, maxHeight: '92%' },
  bankCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 17, borderWidth: 1, padding: 12 },
  bankCardLogoFrame: { width: 52, height: 52, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  bankCardLogo: { width: 42, height: 42 },
  bankCardLabel: { fontFamily: 'Montserrat_700Bold', fontSize: 8.5, letterSpacing: 1.1 },
  bankCardName: { fontFamily: 'Montserrat_700Bold', fontSize: 14.5, marginTop: 2 },
  bankCardMeta: { fontFamily: 'Montserrat_400Regular', fontSize: 11, marginTop: 2 },
  bankCardChange: { paddingHorizontal: 6, paddingVertical: 4 },
  bankCardChangeText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 12.5 },
  registrationBankTypeRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  registrationBankTypeChip: { flex: 1, borderRadius: 999, borderWidth: 1, alignItems: 'center', paddingVertical: 10 },
  registrationBankTypeText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  registrationBankNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 13, padding: 11, marginTop: 12 },
  registrationBankNoteText: { flex: 1, fontFamily: 'Montserrat_400Regular', fontSize: 11, lineHeight: 16 },
  settingsProfile: { borderRadius: 20, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 28 },
  profileInitials: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  profileInitialText: { fontFamily: 'Montserrat_700Bold', color: '#0A0A0A', fontSize: 16 },
  settingsName: { fontFamily: 'Montserrat_700Bold', color: '#FFFFFF', fontSize: 15 },
  settingsPhone: { fontFamily: 'Montserrat_400Regular', color: '#A7A7A7', fontSize: 12, marginTop: 5 },
  categoryCard: { borderWidth: 1, borderRadius: 20, padding: 14, marginBottom: 23 },
  categoryIntro: { fontFamily: 'Montserrat_400Regular', fontSize: 12, lineHeight: 17, marginBottom: 12 },
  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 9 },
  categoryChipText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 11 },
  individualNote: { borderRadius: 16, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 23 },
  individualNoteText: { flex: 1, fontFamily: 'Montserrat_400Regular', fontSize: 11, lineHeight: 16 },
  settingsCard: { borderWidth: 1, borderRadius: 20, padding: 14, marginBottom: 23 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  settingIcon: { width: 37, height: 37, borderRadius: 18.5, alignItems: 'center', justifyContent: 'center' },
  settingCopy: { flex: 1 },
  settingTitle: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  settingSubtitle: { fontFamily: 'Montserrat_400Regular', fontSize: 11, marginTop: 4 },
  toggle: { width: 42, height: 25, borderRadius: 20, padding: 3, justifyContent: 'center' },
  toggleThumb: { width: 19, height: 19, borderRadius: 10 },
  syncButton: { minHeight: 39, borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 13 },
  syncButtonText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  settingsNote: { borderRadius: 16, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  settingsNoteText: { flex: 1, fontFamily: 'Montserrat_400Regular', fontSize: 11, lineHeight: 16 },
  logoutButton: { minHeight: 51, borderRadius: 999, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 22 },
  logoutText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  splashGradient: { flex: 1, width: '100%', alignItems: 'center' },
  splashCircle: { width: 112, height: 112, borderRadius: 56, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', shadowColor: '#053D3D', shadowOpacity: 0.2, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  splashCircleCompact: { width: 92, height: 92, borderRadius: 46 },
  splashWordmark: { fontFamily: 'Montserrat_700Bold', fontSize: 34, color: '#FFFFFF', marginTop: 14, textAlign: 'center', letterSpacing: 0.5 },
  splashBrandCard: { marginTop: 14, backgroundColor: '#FFFFFF', borderRadius: 32, padding: 14, alignItems: 'center', justifyContent: 'center', shadowColor: '#053D3D', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  splashBrandCardCompact: { marginTop: 8, borderRadius: 26, padding: 10 },
  splashTagline: { fontFamily: 'Montserrat_400Regular', fontSize: 13, color: '#5F594D', marginTop: 8, textAlign: 'center' },
  splashMiddle: { gap: 18, width: '100%' },
  splashMiddleCompact: { gap: 12 },
  splashActionsRow: { flexDirection: 'row', justifyContent: 'space-evenly', width: '100%' },
  splashActionItem: { alignItems: 'center', minWidth: 84 },
  splashActionCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', shadowColor: '#4A3A1A', shadowOpacity: 0.1, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  splashActionLabel: { fontFamily: 'Montserrat_500Medium', fontSize: 11, color: '#453F33', marginTop: 8, textAlign: 'center' },
  splashCard: { backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, width: '100%' },
  splashCardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  splashCardLabel: { fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.4, color: '#6B6558' },
  splashCardAmount: { fontFamily: 'Montserrat_700Bold', fontSize: 30, letterSpacing: -0.8, color: '#181410', marginTop: 12 },
  splashCardFoot: { fontFamily: 'Montserrat_400Regular', fontSize: 11, color: '#6B6558', marginTop: 8 },
  splashPill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 28, minHeight: 56, paddingHorizontal: 20, backgroundColor: '#E9A820', alignSelf: 'stretch', shadowColor: '#6B4E0A', shadowOpacity: 0.25, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 4 },
  splashPillText: { fontFamily: 'Montserrat_700Bold', fontSize: 15, color: '#211A12' },
  splashHeadline: { fontFamily: 'Montserrat_700Bold', fontSize: 26, lineHeight: 32, color: '#211A12', textAlign: 'center', marginTop: 18 },
  splashSubline: { fontFamily: 'Montserrat_400Regular', fontSize: 14, lineHeight: 20, color: '#5F594D', textAlign: 'center', marginTop: 8, maxWidth: 300 },
  splashSecondaryCta: { minHeight: 52, borderRadius: 26, borderWidth: 1.5, borderColor: '#D9CDB0', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  splashLoginCta: { flexDirection: 'row', gap: 8, borderColor: '#E9A820' },
  splashSecondaryCtaText: { fontFamily: 'Montserrat_700Bold', fontSize: 15, color: '#211A12' },
  splashQuietLink: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13, color: '#57534A' },
  splashChipsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  splashChip: { backgroundColor: '#ECE3CD', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  splashChipText: { fontFamily: 'Montserrat_500Medium', fontSize: 11, color: '#453F33' },
  authLogoCircle: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', shadowColor: '#053D3D', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  authBrandCard: { backgroundColor: '#FFFFFF', borderRadius: 26, padding: 10, alignItems: 'center', justifyContent: 'center', shadowColor: '#053D3D', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  authWordmark: { fontFamily: 'Montserrat_700Bold', fontSize: 26, color: '#FFFFFF', marginTop: 12, textAlign: 'center', letterSpacing: 0.5 },
  authTagline: { fontFamily: 'Montserrat_400Regular', fontSize: 12, color: '#5F594D', marginTop: 10, textAlign: 'center' },
  authSheet: { borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 24, paddingTop: 28, marginTop: 26, alignItems: 'center', width: '100%' },
  headerLogoCircle: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#E9A820', alignItems: 'center', justifyContent: 'center' },
  headerTitleOnTeal: { fontFamily: 'Montserrat_700Bold', fontSize: 15, color: '#FFFFFF' },
  headerSubtitleOnTeal: { fontFamily: 'Montserrat_400Regular', fontSize: 12, marginTop: 3, color: 'rgba(255,255,255,0.78)' },
  headerSettingsButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 17, borderColor: 'rgba(255,255,255,0.35)' },
  homeBand: { paddingHorizontal: 18, paddingBottom: 24, borderBottomLeftRadius: 28, borderBottomRightRadius: 28 },
  homeBody: { paddingHorizontal: 18 },
  balanceCardWhite: { borderRadius: 24, padding: 19, marginTop: 18, minHeight: 148, backgroundColor: '#FFFFFF', shadowColor: '#3A2E1A', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
  balanceAmountDark: { fontFamily: 'Montserrat_700Bold', fontSize: 34, letterSpacing: -1.2, marginTop: 19 },
  secureBadgeLight: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 5 },
  secureBadgeTextLight: { fontFamily: 'Montserrat_500Medium', fontSize: 11 },
  sheetHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: '#D8D8D3', alignSelf: 'center', marginBottom: 16 },
  pinSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, width: '100%', maxWidth: 480, alignSelf: 'center', maxHeight: '94%' },
  pinSheetScroll: { width: '100%' },
  pinSheetContent: { alignItems: 'center', padding: 24, paddingTop: 14 },
  processingBlock: { alignItems: 'center', gap: 12, paddingVertical: 34 },
  processingText: { fontFamily: 'Montserrat_500Medium', fontSize: 13 },
  resultButton: { alignSelf: 'stretch', marginTop: 20 },
  resultCard: { width: '100%', borderRadius: 18, borderWidth: 1, padding: 16, marginTop: 20, gap: 10 },
  resultRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  resultRowLabel: { fontFamily: 'Montserrat_400Regular', fontSize: 12 },
  resultRowValue: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
});
