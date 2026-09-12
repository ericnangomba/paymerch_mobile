import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { AccountType, BusinessCategory, Transaction, UserProfile, PaymentRequest, useWallet } from '@/state/paymerch-context';

type Screen = 'home' | 'pay' | 'scan' | 'vas' | 'activity' | 'settings';
type IconName = React.ComponentProps<typeof Feather>['name'];
const businessCategories: BusinessCategory[] = [
  'Spaza shop',
  'Street vendor',
  'Carwash',
  'Tshisa nyama',
  'Street food stall',
  'Tomatoes & veggies',
  'Mini bus taxi',
];

const logo = require('../assets/images/paymerch-icon.png');

const zar = (amount: number) =>
  `R${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: any;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      onPress={() => {
        if (disabled) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.();
      }}
      style={({ pressed }) => [style, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {children}
    </Pressable>
  );
}

function BrandMark({ size = 42 }: { size?: number }) {
  return <Image source={logo} style={{ width: size, height: size, borderRadius: size * 0.28 }} />;
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

function PinConfirmationModal({ visible, onConfirm, onCancel, title, error: externalError, onClearError }: { visible: boolean; onConfirm: (pin: string) => void; onCancel: () => void; title: string; error?: string; onClearError?: () => void }) {
  const colors = useColors();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Use external error if provided
  const displayError = externalError || error;

  const handleDigit = (digit: string) => {
    if (pin.length >= 6 || isProcessing) return;
    const next = `${pin}${digit}`;
    setPin(next);
    setError('');
    onClearError?.();
    if (next.length === 6) {
      setIsProcessing(true);
      onConfirm(next);
      // Parent component will handle success/failure and close modal
      setTimeout(() => {
        setIsProcessing(false);
      }, 300);
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.pinModal, { backgroundColor: colors.card }]}>
          <View style={styles.pinModalHeader}>
            <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>SECURITY CHECK</Text>
            <Text style={[styles.pinModalTitle, { color: colors.foreground }]}>{title}</Text>
            <HapticPressable onPress={onCancel} style={styles.closeButton}>
              <Feather name="x" size={20} color={colors.foreground} />
            </HapticPressable>
          </View>
          <Text style={[styles.authSubtitle, { color: colors.mutedForeground }, { textAlign: 'center', marginTop: 10 }]}>
            Enter your PIN to confirm this transaction
          </Text>
          <View style={styles.pinDots}>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <View
                key={index}
                style={[styles.pinDot, { backgroundColor: index < pin.length ? colors.foreground : colors.border }]}
              />
            ))}
          </View>
          {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}
          <View style={styles.pinPad}>
            {keys.map((key) => (
              <HapticPressable key={key} onPress={() => void handleDigit(key)} style={styles.pinKey}>
                <Text style={[styles.pinKeyText, { color: colors.foreground }]}>{key}</Text>
              </HapticPressable>
            ))}
            <View style={styles.pinKey} />
            <HapticPressable onPress={() => void handleDigit('0')} style={styles.pinKey}>
              <Text style={[styles.pinKeyText, { color: colors.foreground }]}>0</Text>
            </HapticPressable>
            <HapticPressable onPress={handleDelete} style={styles.pinKey}>
              <Feather name="delete" size={21} color={colors.foreground} />
            </HapticPressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function AuthScreen() {
  const colors = useColors();
  const { login, biometricLogin, isRegistered } = useWallet();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [registrationMessage, setRegistrationMessage] = useState('');
  const [biometricLabel, setBiometricLabel] = useState('Use device unlock');

  // If not registered, show registration screen by default
  useEffect(() => {
    if (!isRegistered) {
      setMode('register');
    }
  }, [isRegistered]);

  useEffect(() => {
    let cancelled = false;
    const loadBiometricLabel = async () => {
      if (Platform.OS === 'web') return;
      try {
        const [hasHardware, isEnrolled] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!hasHardware || !isEnrolled || cancelled) return;
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        const label = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
          ? 'Use Face ID'
          : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
            ? 'Use fingerprint'
            : 'Use device unlock';
        if (!cancelled) setBiometricLabel(label);
      } catch {
        // The PIN remains available when device authentication cannot be inspected.
      }
    };
    void loadBiometricLabel();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBiometricUnlock = async () => {
    setError('');
    if (Platform.OS === 'web') {
      setError('Biometrics are available on a physical device. Use your PIN in this preview.');
      return;
    }
    try {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hasHardware || !isEnrolled) {
        setError('No enrolled biometrics were found. Use your 6-digit PIN instead.');
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Paymerch Mobile',
        cancelLabel: 'Use PIN',
        fallbackLabel: 'Use PIN',
      });
      if (result.success) {
        await biometricLogin();
      } else if (result.error !== 'user_cancel' && result.error !== 'system_cancel') {
        setError('Biometric unlock was not completed. Use your 6-digit PIN.');
      }
    } catch {
      setError('Biometric unlock is unavailable. Use your 6-digit PIN.');
    }
  };

  const enterDigit = async (digit: string) => {
    if (pin.length >= 6) return;
    const next = `${pin}${digit}`;
    setPin(next);
    setError('');
    setRegistrationMessage('');
    if (next.length === 6) {
      const valid = await login(next);
      if (!valid) {
        setError('That PIN did not match. Please try again.');
        setPin('');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
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

  const authContent = (
    <View style={[styles.authRoot, { backgroundColor: colors.background }]}>
      <View style={styles.authTop}>
        <BrandMark size={58} />
        <Text style={[styles.brandName, { color: colors.foreground }]}>PAYMERCH MOBILE</Text>
        <Text style={[styles.tagline, { color: colors.mutedForeground }]}>Simply Secure Payments</Text>
      </View>
      <View style={styles.authBody}>
        <Text style={[styles.authEyebrow, { color: colors.mutedForeground }]}>WELCOME BACK</Text>
        <Text style={[styles.authTitle, { color: colors.foreground }]}>Enter your PIN</Text>
        <Text style={[styles.authSubtitle, { color: colors.mutedForeground }]}>
          Unlock your wallet to continue.
        </Text>
        <View style={styles.pinDots}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <View
              key={index}
              style={[styles.pinDot, { backgroundColor: index < pin.length ? colors.foreground : colors.border }]}
            />
          ))}
        </View>
        {registrationMessage ? <Text style={[styles.errorText, { color: colors.success }]}>{registrationMessage}</Text> : null}
        {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}
        <View style={styles.pinPad}>
          {keys.map((key) => (
            <HapticPressable key={key} testID={`pin-${key}`} onPress={() => void enterDigit(key)} style={styles.pinKey}>
              <Text style={[styles.pinKeyText, { color: colors.foreground }]}>{key}</Text>
            </HapticPressable>
          ))}
          <HapticPressable onPress={() => void handleBiometricUnlock()} style={styles.pinKey}>
            <Feather name="lock" size={20} color={colors.foreground} />
          </HapticPressable>
          <HapticPressable onPress={() => void enterDigit('0')} style={styles.pinKey}>
            <Text style={[styles.pinKeyText, { color: colors.foreground }]}>0</Text>
          </HapticPressable>
          <HapticPressable onPress={deleteDigit} style={styles.pinKey}>
            <Feather name="delete" size={21} color={colors.foreground} />
          </HapticPressable>
        </View>
        <HapticPressable onPress={() => void handleBiometricUnlock()} style={styles.biometricButton}>
          <Feather name="smartphone" size={17} color={colors.foreground} />
          <Text style={[styles.biometricText, { color: colors.foreground }]}>{biometricLabel}</Text>
        </HapticPressable>
        <Text style={[styles.demoHint, { color: colors.mutedForeground }]}>Enter your 6-digit PIN to unlock</Text>
      </View>
      <Text style={[styles.secureFooter, { color: colors.mutedForeground }]}>
        <Feather name="shield" size={12} /> Your wallet is secured on this device
      </Text>
    </View>
  );

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

function AppSplashScreen({ onContinue }: { onContinue: () => void }) {
  const colors = useColors();
  const logoOpacity = useMemo(() => new Animated.Value(0), []);
  const logoScale = useMemo(() => new Animated.Value(0.8), []);
  const textOpacity = useMemo(() => new Animated.Value(0), []);
  const textTranslateY = useMemo(() => new Animated.Value(20), []);
  const buttonOpacity = useMemo(() => new Animated.Value(0), []);
  const buttonTranslateY = useMemo(() => new Animated.Value(30), []);
  const buttonScale = useMemo(() => new Animated.Value(1), []);

  useEffect(() => {
    const animations = Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.spring(logoScale, {
          toValue: 1,
          friction: 8,
          tension: 40,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(textTranslateY, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(buttonOpacity, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(buttonTranslateY, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    ]);

    animations.start();

    // Add a subtle pulse animation to the button
    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(buttonScale, {
          toValue: 1.05,
          duration: 1500,
          useNativeDriver: true,
        }),
        Animated.timing(buttonScale, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
        }),
      ])
    );
    pulseAnimation.start();

    return () => {
      animations.stop();
      pulseAnimation.stop();
    };
  }, []);

  const splashContent = (
    <View style={[styles.splashRoot, { backgroundColor: colors.background }]}>
      <View style={styles.splashCenter}>
        <Animated.View style={{ opacity: logoOpacity, transform: [{ scale: logoScale }] }}>
          <BrandMark size={86} />
        </Animated.View>
        <Animated.View style={{ opacity: textOpacity, transform: [{ translateY: textTranslateY }] }}>
          <Text style={[styles.splashBrandName, { color: colors.foreground }]}>PAYMERCH MOBILE</Text>
          <Text style={[styles.splashTagline, { color: colors.mutedForeground }]}>Simply Secure Payments</Text>
        </Animated.View>
      </View>
      <Animated.View style={{ opacity: buttonOpacity, transform: [{ translateY: buttonTranslateY }] }}>
        <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
          <HapticPressable onPress={onContinue} style={[styles.splashAction, { backgroundColor: colors.accent }]}>
            <Text style={[styles.splashActionText, { color: colors.accentForeground }]}>Get started</Text>
            <Feather name="arrow-right" size={16} color={colors.accentForeground} />
          </HapticPressable>
        </Animated.View>
      </Animated.View>
    </View>
  );

  // Add web container for proper centering on web
  if (Platform.OS === 'web') {
    return (
      <View style={styles.webContainer}>
        {splashContent}
      </View>
    );
  }

  return splashContent;
}

function RegistrationScreen({ onBack, onRegistered }: { onBack: () => void; onRegistered: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { registerAccount } = useWallet();
  const [accountType, setAccountType] = useState<AccountType>('business');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState<BusinessCategory>('Spaza shop');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    const normalizedPhone = phone.replace(/\D/g, '');
    if (name.trim().length < 2) {
      setError(accountType === 'business' ? 'Enter your business or trading name.' : 'Enter your full name.');
      return;
    }
    if (normalizedPhone.length < 9) {
      setError('Enter a valid mobile number.');
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
    };
    await registerAccount(profile, pin);
    onRegistered();
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.registrationRoot, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 26 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.registrationHeader}>
        <HapticPressable onPress={onBack} style={styles.backButton}>
          <Feather name="arrow-left" size={21} color={colors.foreground} />
        </HapticPressable>
        <BrandMark size={42} />
        <View style={{ width: 42 }} />
      </View>
      <Text style={[styles.authEyebrow, { color: colors.mutedForeground }]}>FIRST TIME SETUP</Text>
      <Text style={[styles.registrationTitle, { color: colors.foreground }]}>Create your wallet</Text>
      <Text style={[styles.registrationSubtitle, { color: colors.mutedForeground }]}>
        Set up your account and PIN for secure transactions.
      </Text>
      <Text style={[styles.formLabel, { color: colors.foreground, marginTop: 25 }]}>I AM REGISTERING AS</Text>
      <View style={[styles.segmented, { backgroundColor: colors.muted }]}>
        {(['business', 'individual'] as AccountType[]).map((type) => {
          const selected = accountType === type;
          return (
            <HapticPressable
              key={type}
              onPress={() => { setAccountType(type); setError(''); }}
              style={[styles.segment, selected && { backgroundColor: colors.card }]}
            >
              <Feather name={type === 'business' ? 'briefcase' : 'user'} size={16} color={selected ? colors.foreground : colors.mutedForeground} />
              <Text style={[styles.segmentText, { color: selected ? colors.foreground : colors.mutedForeground }]}>
                {type === 'business' ? 'Business' : 'Individual'}
              </Text>
            </HapticPressable>
          );
        })}
      </View>
      <Text style={[styles.formLabel, { color: colors.foreground }]}>{accountType === 'business' ? 'BUSINESS OR TRADING NAME' : 'FULL NAME'}</Text>
      <TextInput
        value={name}
        onChangeText={(value) => { setName(value); setError(''); }}
        placeholder={accountType === 'business' ? 'e.g. Lungile’s Spaza' : 'e.g. Lungile Mokoena'}
        placeholderTextColor={colors.mutedForeground}
        autoCapitalize="words"
        style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
      />
      {accountType === 'business' ? (
        <>
          <Text style={[styles.formLabel, { color: colors.foreground, marginTop: 20 }]}>TYPE OF BUSINESS</Text>
          <View style={styles.categoryGrid}>
            {businessCategories.map((item) => {
              const selected = category === item;
              return (
                <HapticPressable
                  key={item}
                  onPress={() => setCategory(item)}
                  style={[styles.categoryChip, { backgroundColor: selected ? colors.foreground : colors.card, borderColor: selected ? colors.foreground : colors.border }]}
                >
                  <Text style={[styles.categoryChipText, { color: selected ? colors.primaryForeground : colors.foreground }]}>{item}</Text>
                </HapticPressable>
              );
            })}
          </View>
        </>
      ) : null}
      <Text style={[styles.formLabel, { color: colors.foreground, marginTop: 20 }]}>MOBILE NUMBER</Text>
      <TextInput
        value={phone}
        onChangeText={(value) => { setPhone(value); setError(''); }}
        placeholder="+27 72 555 0198"
        placeholderTextColor={colors.mutedForeground}
        keyboardType="phone-pad"
        style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
      />
      <View style={styles.registrationPinRow}>
        <View style={styles.registrationPinField}>
          <Text style={[styles.formLabel, { color: colors.foreground }]}>6-DIGIT PIN</Text>
          <TextInput
            value={pin}
            onChangeText={(value) => { setPin(value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
            placeholder="••••••"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
        </View>
        <View style={styles.registrationPinField}>
          <Text style={[styles.formLabel, { color: colors.foreground }]}>CONFIRM PIN</Text>
          <TextInput
            value={confirmPin}
            onChangeText={(value) => { setConfirmPin(value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
            placeholder="••••••"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
        </View>
      </View>
      {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}
      <HapticPressable onPress={() => void submit()} style={[styles.primaryButton, { backgroundColor: colors.foreground, marginTop: 22 }]}>
        <Feather name="arrow-right" size={18} color={colors.primaryForeground} />
        <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>Create account</Text>
      </HapticPressable>
      <Text style={[styles.registrationNote, { color: colors.mutedForeground }]}>
        Your account details and PIN are stored on this device in this prototype.
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
  const colors = useColors();
  return (
    <View style={styles.header}>
      <View style={styles.headerIdentity}>
        <BrandMark size={42} />
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>{title}</Text>
          <Text style={[styles.headerSubtitle, { color: colors.mutedForeground }]}>{subtitle}</Text>
        </View>
      </View>
      <View style={styles.headerActions}>
        <StatusPill online={online} colors={colors} />
        <HapticPressable onPress={onSettings} style={[styles.iconButton, { borderColor: colors.border }]}>
          <Feather name="sliders" size={18} color={colors.foreground} />
        </HapticPressable>
      </View>
    </View>
  );
}

function BalanceCard({ balance, online, onToggle, label }: { balance: number; online: boolean; onToggle: () => void; label: string }) {
  const colors = useColors();
  const [hidden, setHidden] = useState(false);
  return (
    <View style={[styles.balanceCard, { backgroundColor: colors.dark }]}>
      <View style={styles.balanceTop}>
        <Text style={styles.balanceLabel}>{label}</Text>
        <HapticPressable onPress={onToggle} style={styles.balanceVisibility}>
          <Feather name={hidden ? 'eye-off' : 'eye'} size={17} color="#B8B8B8" />
        </HapticPressable>
      </View>
      <Text style={styles.balanceAmount}>{hidden ? '••••••' : zar(balance)}</Text>
      <View style={styles.balanceBottom}>
        <Text style={styles.balanceFoot}>Available balance · ZAR</Text>
        <View style={styles.secureBadge}>
          <Feather name="shield" size={12} color="#A7F3D0" />
          <Text style={styles.secureBadgeText}>{online ? 'Synced' : 'Pending sync'}</Text>
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
    <HapticPressable onPress={onPress} style={[styles.quickAction, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.quickIcon, { backgroundColor: colors.muted }]}>
        <Feather name={icon} size={18} color={colors.foreground} />
      </View>
      <Text style={[styles.quickLabel, { color: colors.foreground }]}>{label}</Text>
      <Feather name="arrow-up-right" size={15} color={colors.mutedForeground} />
    </HapticPressable>
  );
}

function HomeScreen({
  onNavigate,
  onOpenCashOut,
}: {
  onNavigate: (screen: Screen) => void;
  onOpenCashOut: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { merchantBalance, online, toggleOnline, transactions, profile } = useWallet();
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 18, paddingBottom: 124 }]}
    >
      <Header
        title={profile.name}
        subtitle={profile.accountType === 'business' ? profile.businessCategory ?? 'Informal business' : 'Individual wallet'}
        online={online}
        onSettings={() => onNavigate('settings')}
      />
      <BalanceCard
        balance={merchantBalance}
        online={online}
        onToggle={toggleOnline}
        label={profile.accountType === 'business' ? 'BUSINESS WALLET' : 'PERSONAL WALLET'}
      />
      <HapticPressable onPress={() => onNavigate('scan')} style={[styles.scanCta, { backgroundColor: colors.foreground }]}>
        <View>
          <Text style={styles.scanCtaEyebrow}>GET PAID</Text>
          <Text style={styles.scanCtaTitle}>Scan customer QR</Text>
          <Text style={styles.scanCtaText}>Your customer shows a one-time QR. You scan once.</Text>
        </View>
        <View style={styles.scanCtaIcon}>
          <Feather name="maximize" size={25} color={colors.foreground} />
        </View>
      </HapticPressable>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Quick actions</Text>
        <Text style={[styles.sectionHint, { color: colors.mutedForeground }]}>Tap to start</Text>
      </View>
      <View style={styles.actionGrid}>
        <QuickAction icon="zap" label="Sell VAS" onPress={() => onNavigate('vas')} />
        <QuickAction icon="credit-card" label="Customer pays" onPress={() => onNavigate('pay')} />
        <QuickAction icon="download" label="Cash out" onPress={onOpenCashOut} />
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
            <Text style={[styles.offlineText, { color: colors.mutedForeground }]}>New scans stay encrypted and sync when you reconnect.</Text>
          </View>
        </View>
      ) : null}
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
          style={[styles.amountKey, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          {key === 'back' ? <Feather name="delete" size={19} color={colors.foreground} /> : <Text style={[styles.amountKeyText, { color: colors.foreground }]}>{key}</Text>}
        </HapticPressable>
      ))}
    </View>
  );
}

function QRCode({ seed }: { seed: string }) {
  const colors = useColors();
  const size = 21;
  const cells = useMemo(() => {
    const hash = Array.from(seed).reduce((total, char, index) => total + char.charCodeAt(0) * (index + 1), 0);
    return Array.from({ length: size * size }, (_, index) => {
      const row = Math.floor(index / size);
      const col = index % size;
      const finder = (startRow: number, startCol: number) => {
        const r = row - startRow;
        const c = col - startCol;
        if (r < 0 || r > 6 || c < 0 || c > 6) return false;
        return r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      };
      if (finder(0, 0) || finder(0, 14) || finder(14, 0)) return true;
      return (hash + row * 17 + col * 31 + row * col) % 7 < 3;
    });
  }, [seed]);
  return (
    <View style={[styles.qrFrame, { backgroundColor: '#FFFFFF', borderColor: colors.border }]}>
      <View style={styles.qrGrid}>
        {cells.map((active, index) => (
          <View key={index} style={[styles.qrCell, { backgroundColor: active ? '#0A0A0A' : '#FFFFFF' }]} />
        ))}
      </View>
    </View>
  );
}

function PayScreen({ onBack }: { onBack: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { buyerBalance, createPaymentRequest, paymentRequest, completePayment } = useWallet();
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

  const handlePinConfirm = (pin: string) => {
    const request = createPaymentRequest(pendingAmount, pin);
    if (request !== null) {
      setLocalPaymentRequest(request);
      setSeconds(60);
      setQrVisible(true);
      setPinModalVisible(false);
      setPinError('');
    } else {
      setPinError('Invalid PIN. Please try again.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <View style={[styles.screenRoot, { backgroundColor: colors.background, paddingTop: insets.top + 18, paddingBottom: 34 }]}>
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
        <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>ENTER AMOUNT</Text>
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
        style={[styles.primaryButton, { backgroundColor: colors.foreground }]}
      >
        <Feather name="maximize" size={18} color={colors.primaryForeground} />
        <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>Show QR to seller</Text>
      </HapticPressable>
      <Modal visible={qrVisible} transparent animationType="fade" onRequestClose={() => setQrVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.qrModal, { backgroundColor: colors.card }]}>
            <View style={styles.qrModalHeader}>
              <View>
                <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>PAYMENT REQUEST</Text>
                <Text style={[styles.qrModalTitle, { color: colors.foreground }]}>{zar(localPaymentRequest?.amount ?? paymentRequest?.amount ?? number)}</Text>
              </View>
              <HapticPressable onPress={() => setQrVisible(false)} style={styles.closeButton}>
                <Feather name="x" size={20} color={colors.foreground} />
              </HapticPressable>
            </View>
            <QRCode seed={localPaymentRequest?.token ?? paymentRequest?.token ?? 'paymerch-demo'} />
            <View style={[styles.timerPill, { backgroundColor: colors.warm }]}>
              <Feather name="clock" size={15} color={colors.warning} />
              <Text style={[styles.timerText, { color: colors.warning }]}>{seconds}s remaining</Text>
            </View>
            <Text style={[styles.qrInstruction, { color: colors.mutedForeground }]}>Show this code to the seller. It can only be used once.</Text>
            <Text style={[styles.tokenText, { color: colors.mutedForeground }]}>{localPaymentRequest?.token ?? paymentRequest?.token ?? 'tok_demo_pm'}</Text>
          </View>
        </View>
      </Modal>
      <PinConfirmationModal
        visible={pinModalVisible}
        onConfirm={handlePinConfirm}
        onCancel={() => setPinModalVisible(false)}
        title="Confirm Payment"
        error={pinError}
        onClearError={() => setPinError('')}
      />
    </View>
  );
}

function ScanScreen({ onBack, onNavigate }: { onBack: () => void; onNavigate: (screen: Screen) => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { paymentRequest, completePayment, online } = useWallet();
  const [result, setResult] = useState<'idle' | 'success' | 'offline'>('idle');
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pendingAmount, setPendingAmount] = useState(0);
  const [pinError, setPinError] = useState('');
  const hasRequest = Boolean(paymentRequest && paymentRequest.expiresAt > Date.now());

  const scan = () => {
    const amount = hasRequest ? paymentRequest?.amount ?? 35 : 35;
    setPendingAmount(amount);
    setPinModalVisible(true);
  };

  const handlePinConfirm = (pin: string) => {
    const success = completePayment(pendingAmount, hasRequest ? 'QR' : 'DEMO', pin);
    if (success) {
      setResult(online ? 'success' : 'offline');
      setPinModalVisible(false);
      setPinError('');
      void Haptics.notificationAsync(online ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    } else {
      setPinError('Invalid PIN. Please try again.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (result !== 'idle') {
    return (
      <View style={[styles.successRoot, { backgroundColor: colors.background, paddingTop: insets.top + 18 }]}>
        <View style={[styles.successMark, { backgroundColor: result === 'success' ? colors.accent : colors.warm }]}>
          <Feather name={result === 'success' ? 'check' : 'clock'} size={34} color={result === 'success' ? colors.success : colors.warning} />
        </View>
          <Text style={[styles.successTitle, { color: colors.foreground }]}>{result === 'success' ? 'Payment received' : 'Payment saved for sync'}</Text>
        <Text style={[styles.successSubtitle, { color: colors.mutedForeground }]}>
          {result === 'success' ? 'The customer and business wallets are updated.' : 'This payment is encrypted on-device and will sync when you reconnect.'}
        </Text>
        <HapticPressable onPress={() => onNavigate('home')} style={[styles.primaryButton, { backgroundColor: colors.foreground }]}>
          <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>Back to dashboard</Text>
        </HapticPressable>
        <HapticPressable onPress={() => setResult('idle')} style={styles.textButton}>
          <Text style={[styles.textButtonLabel, { color: colors.foreground }]}>Scan another payment</Text>
        </HapticPressable>
      </View>
    );
  }

  return (
    <View style={[styles.scannerRoot, { backgroundColor: colors.dark, paddingTop: insets.top + 18, paddingBottom: insets.bottom + 18 }]}>
      <View style={styles.scannerHeader}>
        <HapticPressable onPress={onBack} style={styles.scannerBack}>
          <Feather name="arrow-left" size={21} color="#FFFFFF" />
        </HapticPressable>
        <View>
          <Text style={styles.scannerEyebrow}>SELLER MODE</Text>
          <Text style={styles.scannerTitle}>Scan customer payment</Text>
        </View>
        <StatusPill online={online} colors={colors} />
      </View>
      <View style={styles.viewfinder}>
        <View style={[styles.corner, styles.cornerTopLeft]} />
        <View style={[styles.corner, styles.cornerTopRight]} />
        <View style={[styles.corner, styles.cornerBottomLeft]} />
        <View style={[styles.corner, styles.cornerBottomRight]} />
        <View style={styles.scanLine} />
        <View style={styles.viewfinderCenter}>
          <Feather name="maximize" size={34} color="rgba(255,255,255,0.75)" />
        </View>
      </View>
      <View style={styles.scannerCopy}>
        <Text style={styles.scannerHint}>{hasRequest ? 'Customer payment detected' : 'Point your camera at the customer’s QR'}</Text>
        <Text style={styles.scannerSubhint}>
          {hasRequest ? `${zar(paymentRequest?.amount ?? 35)} · Expires in 60 seconds` : 'The customer QR is single-use and signed.'}
        </Text>
      </View>
      <HapticPressable onPress={scan} style={[styles.scanDemoButton, { backgroundColor: colors.card }]}>
        <Feather name="camera" size={18} color={colors.foreground} />
        <Text style={[styles.scanDemoText, { color: colors.foreground }]}>{hasRequest ? 'Collect customer payment' : 'Use demo payment · R35'}</Text>
      </HapticPressable>
      <Text style={styles.scannerFootnote}>Camera access is simulated in this prototype</Text>
      <PinConfirmationModal
        visible={pinModalVisible}
        onConfirm={handlePinConfirm}
        onCancel={() => setPinModalVisible(false)}
        title="Confirm Payment"
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
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState(50);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const options = kind === 'VAS_ELEC' ? [20, 50, 100, 200] : [10, 20, 50, 100];

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

  const handlePinConfirm = (pin: string) => {
    const result = vendVas(kind, amount, destination, pin);
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
              <Text style={[styles.tokenCaption, { color: colors.mutedForeground }]}>STS ELECTRICITY TOKEN · R{amount}</Text>
            </View>
          ) : (
            <View style={[styles.tokenBox, { backgroundColor: colors.muted }]}>
              <Text style={[styles.tokenValue, { color: colors.foreground }]}>R{amount}.00</Text>
              <Text style={[styles.tokenCaption, { color: colors.mutedForeground }]}>AIRTIME VALUE</Text>
            </View>
          )}
          <HapticPressable onPress={() => setToken(null)} style={[styles.primaryButton, { backgroundColor: colors.foreground }]}>
            <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>Vend another</Text>
          </HapticPressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 18, paddingBottom: 42 }]}>
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
      <View style={[styles.segmented, { backgroundColor: colors.muted }]}>
        <HapticPressable onPress={() => { setKind('VAS_ELEC'); setError(''); }} style={[styles.segment, kind === 'VAS_ELEC' && { backgroundColor: colors.card }]}>
          <Feather name="zap" size={16} color={kind === 'VAS_ELEC' ? colors.foreground : colors.mutedForeground} />
          <Text style={[styles.segmentText, { color: kind === 'VAS_ELEC' ? colors.foreground : colors.mutedForeground }]}>Electricity</Text>
        </HapticPressable>
        <HapticPressable onPress={() => { setKind('VAS_AIRTIME'); setError(''); }} style={[styles.segment, kind === 'VAS_AIRTIME' && { backgroundColor: colors.card }]}>
          <Feather name="phone" size={16} color={kind === 'VAS_AIRTIME' ? colors.foreground : colors.mutedForeground} />
          <Text style={[styles.segmentText, { color: kind === 'VAS_AIRTIME' ? colors.foreground : colors.mutedForeground }]}>Airtime</Text>
        </HapticPressable>
      </View>
      <Text style={[styles.formLabel, { color: colors.foreground }]}>{kind === 'VAS_ELEC' ? 'Meter number' : 'Phone number'}</Text>
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
            <Text style={[styles.vasOptionText, { color: amount === option ? colors.primaryForeground : colors.foreground }]}>R{option}</Text>
          </HapticPressable>
        ))}
      </View>
      {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}
      <HapticPressable onPress={vend} style={[styles.primaryButton, { backgroundColor: colors.foreground, marginTop: 28 }]}>
        <Feather name="zap" size={18} color={colors.primaryForeground} />
        <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>Generate {kind === 'VAS_ELEC' ? 'electricity token' : 'airtime'}</Text>
      </HapticPressable>
      <View style={[styles.infoBanner, { backgroundColor: colors.accent }]}>
        <Feather name="info" size={16} color={colors.accentForeground} />
        <Text style={[styles.infoText, { color: colors.accentForeground }]}>VAS sales are recorded in your wallet activity. Offline sales will show as pending until synced.</Text>
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
  const { online, toggleOnline, syncPending, transactions, logout, businessCategory, setBusinessCategory, profile } = useWallet();
  const pending = transactions.filter((transaction) => transaction.status === 'PENDING SYNC').length;
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
                    style={[styles.categoryChip, { backgroundColor: selected ? colors.foreground : colors.muted, borderColor: selected ? colors.foreground : colors.border }]}
                  >
                    <Text style={[styles.categoryChipText, { color: selected ? colors.primaryForeground : colors.foreground }]}>{category}</Text>
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
            <Text style={[styles.settingTitle, { color: colors.foreground }]}>{online ? 'Connected' : 'Offline mode'}</Text>
            <Text style={[styles.settingSubtitle, { color: colors.mutedForeground }]}>{online ? 'Transactions sync instantly' : `${pending} item${pending === 1 ? '' : 's'} waiting to sync`}</Text>
          </View>
          <HapticPressable onPress={toggleOnline} style={[styles.toggle, { backgroundColor: online ? colors.success : colors.border }]}>
            <View style={[styles.toggleThumb, { backgroundColor: colors.card, alignSelf: online ? 'flex-end' : 'flex-start' }]} />
          </HapticPressable>
        </View>
        {!online && pending > 0 ? (
          <HapticPressable onPress={() => { toggleOnline(); syncPending(); }} style={[styles.syncButton, { backgroundColor: colors.muted }]}>
            <Feather name="refresh-cw" size={15} color={colors.foreground} />
            <Text style={[styles.syncButtonText, { color: colors.foreground }]}>Reconnect & sync now</Text>
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
        <Text style={[styles.settingsNoteText, { color: colors.mutedForeground }]}>This prototype keeps balances on-device to demonstrate the product flow. A production wallet keeps balances on the secure backend ledger.</Text>
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
            <View style={[styles.navIcon, active && { backgroundColor: colors.foreground }]}>
              <Feather name={item.icon} size={18} color={active ? colors.primaryForeground : colors.mutedForeground} />
            </View>
            <Text style={[styles.navLabel, { color: active ? colors.foreground : colors.mutedForeground }]}>{item.label}</Text>
          </HapticPressable>
        );
      })}
    </View>
  );
}

export default function PaymerchHome() {
  const { ready, signedIn } = useWallet();
  const [screen, setScreen] = useState<Screen>('home');
  const [cashOutVisible, setCashOutVisible] = useState(false);
  const [cashOutAmount, setCashOutAmount] = useState('100');
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [cashOutError, setCashOutError] = useState('');
  const [splashAcknowledged, setSplashAcknowledged] = useState(false);
  const colors = useColors();
  const { cashOut, merchantBalance } = useWallet();

  const handleCashOutPinConfirm = (pin: string) => {
    if (cashOut(Number(cashOutAmount), pin)) {
      setCashOutVisible(false);
      setPinModalVisible(false);
      setCashOutError('');
    } else {
      setCashOutError('Invalid PIN. Please try again.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (!splashAcknowledged || !ready) return <AppSplashScreen onContinue={() => setSplashAcknowledged(true)} />;
  if (!signedIn) return <AuthScreen />;

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
    return <HomeScreen onNavigate={navigate} onOpenCashOut={() => setCashOutVisible(true)} />;
  };

  const mainContent = (
    <View style={styles.appRoot}>
      {renderScreen()}
      {['home', 'pay', 'vas'].includes(screen) ? <BottomNav screen={screen} onNavigate={navigate} /> : null}
      <Modal visible={cashOutVisible} transparent animationType="slide" onRequestClose={() => setCashOutVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.cashOutModal, { backgroundColor: colors.card }]}>
            <View style={styles.qrModalHeader}>
              <View>
                <Text style={[styles.pageEyebrow, { color: colors.mutedForeground }]}>BUSINESS WALLET · {zar(merchantBalance)}</Text>
                <Text style={[styles.qrModalTitle, { color: colors.foreground }]}>Cash out</Text>
              </View>
              <HapticPressable onPress={() => setCashOutVisible(false)} style={styles.closeButton}><Feather name="x" size={20} color={colors.foreground} /></HapticPressable>
            </View>
            <Text style={[styles.formLabel, { color: colors.foreground }]}>AMOUNT</Text>
            <TextInput value={cashOutAmount} onChangeText={setCashOutAmount} keyboardType="decimal-pad" style={[styles.textInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />
            <HapticPressable
              onPress={() => {
                setPinModalVisible(true);
              }}
              disabled={Number(cashOutAmount) <= 0 || Number(cashOutAmount) > merchantBalance}
              style={[styles.primaryButton, { backgroundColor: colors.foreground, marginTop: 18 }]}
            >
              <Feather name="download" size={18} color={colors.primaryForeground} />
              <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>Confirm cash out</Text>
            </HapticPressable>
          </View>
        </View>
      </Modal>
      <PinConfirmationModal
        visible={pinModalVisible}
        onConfirm={handleCashOutPinConfirm}
        onCancel={() => setPinModalVisible(false)}
        title="Confirm Cash Out"
        error={cashOutError}
        onClearError={() => setCashOutError('')}
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
  webContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FBFBFA' },
  loadingRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { fontFamily: 'Inter_500Medium', fontSize: 14 },
  splashRoot: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 120, paddingBottom: 60 },
  splashCenter: { alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, width: '100%' },
  splashBrandName: { fontFamily: 'Inter_700Bold', fontSize: 18, letterSpacing: 3.8, textAlign: 'left', alignSelf: 'flex-start' },
  splashTagline: { fontFamily: 'Inter_400Regular', fontSize: 13, textAlign: 'left', alignSelf: 'flex-start' },
  splashAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, minWidth: 150, paddingHorizontal: 18, paddingVertical: 13, alignSelf: 'center' },
  splashActionText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  authRoot: { flex: 1, paddingHorizontal: 24, justifyContent: 'space-between', maxWidth: 480, alignSelf: 'center', width: '100%' },
  authTop: { alignItems: 'flex-start', paddingTop: 76, gap: 5, width: '100%' },
  brandName: { fontFamily: 'Inter_700Bold', fontSize: 16, letterSpacing: 3.4, textAlign: 'left', alignSelf: 'flex-start' },
  tagline: { fontFamily: 'Inter_400Regular', fontSize: 13, textAlign: 'left', alignSelf: 'flex-start' },
  authBody: { alignItems: 'center', width: '100%', marginTop: 20 },
  authEyebrow: { fontFamily: 'Inter_700Bold', fontSize: 11, letterSpacing: 1.6 },
  authTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, marginTop: 8 },
  authSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 14, marginTop: 9 },
  pinDots: { flexDirection: 'row', gap: 12, marginTop: 28, marginBottom: 14 },
  pinDot: { width: 10, height: 10, borderRadius: 5 },
  errorText: { fontFamily: 'Inter_500Medium', fontSize: 12, textAlign: 'center', marginTop: 7, maxWidth: 290 },
  registerLink: { padding: 10, marginTop: 5 },
  registerLinkText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  registrationRoot: { paddingHorizontal: 18 },
  registrationHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 },
  registrationTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, marginTop: 8 },
  registrationSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 20, marginTop: 9, maxWidth: 330 },
  registrationPinRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  registrationPinField: { flex: 1 },
  registrationNote: { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 13, paddingHorizontal: 18 },
  pinPad: { width: '100%', maxWidth: 330, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12, marginTop: 14 },
  pinKey: { width: 92, height: 53, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  pinKeyText: { fontFamily: 'Inter_500Medium', fontSize: 22 },
  biometricButton: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10, marginTop: 10 },
  biometricText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  demoHint: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 2 },
  secureFooter: { textAlign: 'center', fontFamily: 'Inter_400Regular', fontSize: 12, paddingBottom: 24 },
  scrollContent: { paddingHorizontal: 18 },
  screenRoot: { flex: 1, paddingHorizontal: 18 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerIdentity: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  headerSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 3 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 20 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  iconButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 12 },
  balanceCard: { borderRadius: 24, padding: 19, marginTop: 20, minHeight: 148 },
  balanceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  balanceLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 1.2, color: '#A7A7A7' },
  balanceVisibility: { padding: 4 },
  balanceAmount: { fontFamily: 'Inter_700Bold', fontSize: 34, letterSpacing: -1.2, color: '#FFFFFF', marginTop: 19 },
  balanceBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 17 },
  balanceFoot: { fontFamily: 'Inter_400Regular', color: '#A7A7A7', fontSize: 12 },
  secureBadge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  secureBadgeText: { fontFamily: 'Inter_500Medium', color: '#A7F3D0', fontSize: 11 },
  pinModal: { borderRadius: 24, padding: 24, width: '90%', maxWidth: 360, alignSelf: 'center' },
  pinModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  pinModalTitle: { fontFamily: 'Inter_700Bold', fontSize: 20, marginTop: 4 },
  scanCta: { borderRadius: 22, minHeight: 112, padding: 18, marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scanCtaEyebrow: { fontFamily: 'Inter_700Bold', color: '#A7A7A7', fontSize: 10, letterSpacing: 1.1 },
  scanCtaTitle: { fontFamily: 'Inter_700Bold', color: '#FFFFFF', fontSize: 22, marginTop: 6 },
  scanCtaText: { fontFamily: 'Inter_400Regular', color: '#B8B8B8', fontSize: 12, marginTop: 4 },
  scanCtaIcon: { width: 56, height: 56, borderRadius: 18, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 25, marginBottom: 11 },
  sectionTitle: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  sectionHint: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  sectionLink: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  actionGrid: { flexDirection: 'row', gap: 8 },
  quickAction: { flex: 1, minHeight: 82, borderRadius: 18, borderWidth: 1, padding: 12, justifyContent: 'space-between' },
  quickIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  quickLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  activityCard: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 14 },
  activityRow: { flexDirection: 'row', alignItems: 'center', minHeight: 73, borderBottomWidth: 1, borderBottomColor: '#F0F0ED' },
  activityIcon: { width: 37, height: 37, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  activityCopy: { flex: 1, paddingLeft: 10 },
  activityTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  activitySubtitle: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 4 },
  activityValue: { alignItems: 'flex-end', gap: 5 },
  activityAmount: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  miniStatus: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  miniStatusText: { fontFamily: 'Inter_600SemiBold', fontSize: 9 },
  offlineBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, padding: 13, marginTop: 14 },
  offlineCopy: { flex: 1 },
  offlineTitle: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  offlineText: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 3, lineHeight: 16 },
  pageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 23 },
  backButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  pageEyebrow: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 1.3 },
  pageTitle: { fontFamily: 'Inter_700Bold', fontSize: 25, marginTop: 4 },
  payBalance: { borderWidth: 1, borderRadius: 18, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 1.2 },
  payBalanceAmount: { fontFamily: 'Inter_700Bold', fontSize: 24, marginTop: 7 },
  payBalanceIcon: { width: 39, height: 39, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  amountHeader: { alignItems: 'center', marginTop: 23 },
  amountDisplay: { fontFamily: 'Inter_700Bold', fontSize: 42, letterSpacing: -1, marginTop: 8 },
  validationText: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 3 },
  quickAmounts: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 15 },
  quickAmount: { borderWidth: 1, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 8 },
  quickAmountText: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  amountKeypad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 9, marginTop: 17 },
  amountKey: { width: '30%', height: 45, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  amountKeyText: { fontFamily: 'Inter_500Medium', fontSize: 19 },
  primaryButton: { minHeight: 53, borderRadius: 17, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 },
  primaryButtonText: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.35 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.58)', justifyContent: 'flex-end' },
  qrModal: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 22, alignItems: 'center', minHeight: 500 },
  qrModalHeader: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  qrModalTitle: { fontFamily: 'Inter_700Bold', fontSize: 30, marginTop: 4 },
  closeButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  qrFrame: { padding: 12, borderRadius: 18, borderWidth: 1 },
  qrGrid: { width: 210, height: 210, flexDirection: 'row', flexWrap: 'wrap' },
  qrCell: { width: 10, height: 10 },
  timerPill: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, marginTop: 16 },
  timerText: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  qrInstruction: { fontFamily: 'Inter_400Regular', fontSize: 12, textAlign: 'center', lineHeight: 17, marginTop: 15, maxWidth: 280 },
  tokenText: { fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 9 },
  scannerRoot: { flex: 1, paddingHorizontal: 18 },
  scannerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scannerBack: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  scannerEyebrow: { fontFamily: 'Inter_700Bold', color: '#8A8A8A', fontSize: 10, letterSpacing: 1.2 },
  scannerTitle: { fontFamily: 'Inter_700Bold', color: '#FFFFFF', fontSize: 22, marginTop: 4 },
  viewfinder: { height: 300, marginTop: 40, position: 'relative', alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', width: 48, height: 48, borderColor: '#FFFFFF' },
  cornerTopLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 14 },
  cornerTopRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 14 },
  cornerBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 14 },
  cornerBottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 14 },
  scanLine: { position: 'absolute', top: '49%', left: 28, right: 28, height: 1, backgroundColor: '#10B981' },
  viewfinderCenter: { width: 80, height: 80, borderRadius: 26, borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)', alignItems: 'center', justifyContent: 'center' },
  scannerCopy: { alignItems: 'center', marginTop: 34 },
  scannerHint: { fontFamily: 'Inter_600SemiBold', color: '#FFFFFF', fontSize: 16 },
  scannerSubhint: { fontFamily: 'Inter_400Regular', color: '#999999', fontSize: 12, marginTop: 8, textAlign: 'center' },
  scanDemoButton: { minHeight: 54, borderRadius: 17, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9, marginTop: 'auto' },
  scanDemoText: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  scannerFootnote: { fontFamily: 'Inter_400Regular', color: '#777777', textAlign: 'center', fontSize: 11, marginTop: 12 },
  successRoot: { flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  successMark: { width: 78, height: 78, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  successTitle: { fontFamily: 'Inter_700Bold', fontSize: 26, marginTop: 20 },
  successSubtitle: { fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20, fontSize: 14, marginTop: 10, maxWidth: 300 },
  textButton: { padding: 15, marginTop: 6 },
  textButtonLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  segmented: { borderRadius: 15, padding: 4, flexDirection: 'row', marginBottom: 27 },
  segment: { flex: 1, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', paddingVertical: 11, borderRadius: 12 },
  segmentText: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  formLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 1.2, marginBottom: 9 },
  textInput: { borderWidth: 1, borderRadius: 15, minHeight: 53, paddingHorizontal: 15, fontFamily: 'Inter_400Regular', fontSize: 14 },
  vasAmountHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 24 },
  balanceHint: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  vasOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  vasOption: { width: '48%', minHeight: 54, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  vasOptionText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  infoBanner: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderRadius: 15, padding: 13, marginTop: 17 },
  infoText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16 },
  receiptCard: { borderRadius: 22, borderWidth: 1, padding: 21, alignItems: 'center', marginTop: 30 },
  receiptMark: { width: 58, height: 58, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  receiptTitle: { fontFamily: 'Inter_700Bold', fontSize: 21, marginTop: 16 },
  receiptSub: { fontFamily: 'Inter_400Regular', textAlign: 'center', fontSize: 12, lineHeight: 17, marginTop: 7 },
  tokenBox: { width: '100%', borderRadius: 15, paddingVertical: 18, paddingHorizontal: 10, alignItems: 'center', marginTop: 22, marginBottom: 20 },
  tokenValue: { fontFamily: 'Inter_700Bold', fontSize: 20, letterSpacing: 1.4, textAlign: 'center' },
  tokenCaption: { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 1, marginTop: 8 },
  bottomNav: { position: 'absolute', bottom: 0, left: 0, right: 0, minHeight: 76, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingTop: 8 },
  navItem: { alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 58 },
  navIcon: { width: 31, height: 26, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  navLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  cashOutModal: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 22, minHeight: 280 },
  settingsProfile: { borderRadius: 20, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 28 },
  profileInitials: { width: 48, height: 48, borderRadius: 17, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  profileInitialText: { fontFamily: 'Inter_700Bold', color: '#0A0A0A', fontSize: 16 },
  settingsName: { fontFamily: 'Inter_700Bold', color: '#FFFFFF', fontSize: 15 },
  settingsPhone: { fontFamily: 'Inter_400Regular', color: '#A7A7A7', fontSize: 12, marginTop: 5 },
  categoryCard: { borderWidth: 1, borderRadius: 20, padding: 14, marginBottom: 23 },
  categoryIntro: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 17, marginBottom: 12 },
  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 9 },
  categoryChipText: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  individualNote: { borderRadius: 16, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 23 },
  individualNoteText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16 },
  settingsCard: { borderWidth: 1, borderRadius: 20, padding: 14, marginBottom: 23 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  settingIcon: { width: 37, height: 37, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  settingCopy: { flex: 1 },
  settingTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  settingSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 4 },
  toggle: { width: 42, height: 25, borderRadius: 20, padding: 3, justifyContent: 'center' },
  toggleThumb: { width: 19, height: 19, borderRadius: 10 },
  syncButton: { minHeight: 39, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 13 },
  syncButtonText: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  settingsNote: { borderRadius: 16, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  settingsNoteText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16 },
  logoutButton: { minHeight: 51, borderRadius: 16, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 22 },
  logoutText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
});