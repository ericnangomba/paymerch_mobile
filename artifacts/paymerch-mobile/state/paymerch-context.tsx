import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

export type TransactionStatus = 'SUCCESS' | 'PENDING SYNC' | 'FAILED';
export type TransactionKind = 'MERCHANT_PAY' | 'VAS_ELEC' | 'VAS_AIRTIME' | 'CASH_OUT';
export type BusinessCategory =
  | 'Spaza shop'
  | 'Street vendor'
  | 'Carwash'
  | 'Tshisa nyama'
  | 'Street food stall'
  | 'Tomatoes & veggies'
  | 'Mini bus taxi';
export type AccountType = 'individual' | 'business';

export type UserProfile = {
  accountType: AccountType;
  name: string;
  phone: string;
  businessCategory?: BusinessCategory;
};

export type Transaction = {
  id: string;
  kind: TransactionKind;
  title: string;
  subtitle: string;
  amount: number;
  status: TransactionStatus;
  createdAt: number;
  direction: 'in' | 'out';
};

export type PaymentRequest = {
  token: string;
  amount: number;
  expiresAt: number;
};

/**
 * Authentication supplied before a transaction is authorized.
 *
 * - `{ pin }` authorizes using the wallet's registered PIN (verified against the
 *   on-device stored PIN).
 * - `{ biometric: true }` authorizes using device biometrics. The caller is
 *   responsible for running `verifyBiometrics()` before invoking the action, so
 *   this branch trusts that a biometric challenge already succeeded.
 */
export type TransactionAuth = { pin: string } | { biometric: true };


type PersistedWallet = {
  isRegistered: boolean;
  buyerBalance: number;
  merchantBalance: number;
  transactions: Transaction[];
  online: boolean;
  paymentRequest: PaymentRequest | null;
  businessCategory?: BusinessCategory;
  profile?: UserProfile;
  pin?: string;
};

type WalletContextValue = {
  ready: boolean;
  signedIn: boolean;
  isRegistered: boolean;
  buyerBalance: number;
  merchantBalance: number;
  transactions: Transaction[];
  online: boolean;
  paymentRequest: PaymentRequest | null;
  businessCategory: BusinessCategory;
  profile: UserProfile;
  biometricAvailable: boolean;
  biometricLabel: string;
  login: (pin: string) => Promise<boolean>;
  biometricLogin: () => Promise<void>;
  verifyBiometrics: () => Promise<boolean>;
  registerAccount: (profile: UserProfile, pin: string) => Promise<void>;
  logout: () => Promise<void>;
  toggleOnline: () => void;
  syncPending: () => void;
  createPaymentRequest: (amount: number, auth: TransactionAuth) => PaymentRequest | null;
  completePayment: (amount: number, source?: 'QR' | 'DEMO', auth?: TransactionAuth) => boolean;
  vendVas: (kind: 'VAS_ELEC' | 'VAS_AIRTIME', amount: number, destination: string, auth: TransactionAuth) => string | null;
  cashOut: (amount: number, auth: TransactionAuth) => boolean;
  setBusinessCategory: (category: BusinessCategory) => void;
};

const STORAGE_KEY = 'paymerch-wallet-v1';
const SESSION_KEY = 'paymerch-session-v1';
const DEFAULT_PROFILE: UserProfile = {
  accountType: 'business',
  name: "Lungile's Market",
  phone: '+27 72 555 0198',
  businessCategory: 'Spaza shop',
};
const DEMO_TRANSACTIONS: Transaction[] = [
  {
    id: 'pm-1',
    kind: 'MERCHANT_PAY',
    title: 'Customer payment',
    subtitle: 'QR payment · Today, 08:42',
    amount: 25,
    status: 'SUCCESS',
    createdAt: Date.now() - 1000 * 60 * 48,
    direction: 'in',
  },
  {
    id: 'pm-2',
    kind: 'VAS_AIRTIME',
    title: 'Airtime vending',
    subtitle: 'Yesterday, 17:18',
    amount: 50,
    status: 'SUCCESS',
    createdAt: Date.now() - 1000 * 60 * 60 * 16,
    direction: 'out',
  },
  {
    id: 'pm-3',
    kind: 'MERCHANT_PAY',
    title: 'Customer payment',
    subtitle: 'QR payment · Yesterday, 13:05',
    amount: 80,
    status: 'SUCCESS',
    createdAt: Date.now() - 1000 * 60 * 60 * 20,
    direction: 'in',
  },
  {
    id: 'pm-4',
    kind: 'VAS_ELEC',
    title: 'Electricity token',
    subtitle: 'Mon, 19:44',
    amount: 100,
    status: 'PENDING SYNC',
    createdAt: Date.now() - 1000 * 60 * 60 * 31,
    direction: 'out',
  },
  {
    id: 'pm-5',
    kind: 'CASH_OUT',
    title: 'Cash out',
    subtitle: 'Mon, 10:23',
    amount: 150,
    status: 'SUCCESS',
    createdAt: Date.now() - 1000 * 60 * 60 * 40,
    direction: 'out',
  },
];

const WalletContext = createContext<WalletContextValue | null>(null);

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [buyerBalance, setBuyerBalance] = useState(425.5);
  const [merchantBalance, setMerchantBalance] = useState(1280.75);
  const [transactions, setTransactions] = useState<Transaction[]>(DEMO_TRANSACTIONS);
  const [online, setOnline] = useState(true);
  const [paymentRequest, setPaymentRequest] = useState<PaymentRequest | null>(null);
  const [businessCategory, setBusinessCategory] = useState<BusinessCategory>('Spaza shop');
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [storedPin, setStoredPin] = useState<string | undefined>(undefined);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState('Use biometrics');

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ])
      .then(([hasHardware, isEnrolled]) => ({ hasHardware, isEnrolled }))
      .then((caps) => {
        if (cancelled) return;
        setBiometricAvailable(caps.hasHardware && caps.isEnrolled);
        if (!caps.hasHardware || !caps.isEnrolled) return;
        LocalAuthentication.supportedAuthenticationTypesAsync()
          .then((types) => {
            if (cancelled) return;
            const label = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
              ? 'Use Face ID'
              : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
                ? 'Use fingerprint'
                : 'Use biometrics';
            setBiometricLabel(label);
          })
          .catch(() => {
            /* Keep the generic label. */
          });
      })
      .catch(() => {
        /* Biometric support is optional; PIN remains a full fallback. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const [walletRaw, session] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY),
        AsyncStorage.getItem(SESSION_KEY),
      ]);
      if (cancelled) return;
      if (walletRaw) {
        try {
          const wallet = JSON.parse(walletRaw) as PersistedWallet;
          setIsRegistered(wallet.isRegistered ?? false);
          setBuyerBalance(wallet.buyerBalance);
          setMerchantBalance(wallet.merchantBalance);
          setTransactions(wallet.transactions);
          setOnline(wallet.online);
          setPaymentRequest(wallet.paymentRequest);
          setBusinessCategory(wallet.businessCategory ?? 'Spaza shop');
          setProfile(wallet.profile ?? DEFAULT_PROFILE);
          setStoredPin(wallet.pin);
        } catch {
          await AsyncStorage.removeItem(STORAGE_KEY);
        }
      }
      setSignedIn(session === 'active');
      setReady(true);
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const wallet: PersistedWallet = {
      isRegistered,
      buyerBalance,
      merchantBalance,
      transactions,
      online,
      paymentRequest,
      businessCategory,
      profile,
      pin: storedPin,
    };
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
  }, [isRegistered, buyerBalance, merchantBalance, transactions, online, paymentRequest, businessCategory, profile, storedPin, ready]);

  const login = useCallback(async (pin: string) => {
    // Check if user is registered
    if (!isRegistered || !storedPin) {
      return false;
    }
    const valid = pin === storedPin;
    if (valid) {
      setSignedIn(true);
      await AsyncStorage.setItem(SESSION_KEY, 'active');
    }
    return valid;
  }, [isRegistered, storedPin]);

  const biometricLogin = useCallback(async () => {
    setSignedIn(true);
    await AsyncStorage.setItem(SESSION_KEY, 'active');
  }, []);

  /**
   * Runs the device's biometric prompt (Face ID / Touch ID / fingerprint).
   *
   * Returns `false` on web, when no biometrics are enrolled, or when the user
   * cancels / fails. Device fallback is disabled so biometrics are required —
   * users who cannot authenticate with biometrics use their PIN instead.
   */
  const verifyBiometrics = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === 'web') return false;
    if (!biometricAvailable) return false;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Paymerch Mobile',
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
        disableDeviceFallback: true,
      });
      return result.success;
    } catch {
      return false;
    }
  }, [biometricAvailable]);

  const authorize = useCallback(
    (auth?: TransactionAuth): boolean => {
      if (!auth) return false;
      if ('biometric' in auth) return true;
      return Boolean(storedPin) && auth.pin === storedPin;
    },
    [storedPin],
  );

  const registerAccount = useCallback(async (nextProfile: UserProfile, pin: string) => {
    setProfile(nextProfile);
    setStoredPin(pin);
    setIsRegistered(true);
    if (nextProfile.businessCategory) {
      setBusinessCategory(nextProfile.businessCategory);
    }
    // Auto-login after successful registration
    setSignedIn(true);
    await AsyncStorage.setItem(SESSION_KEY, 'active');
  }, []);

  const logout = useCallback(async () => {
    setSignedIn(false);
    await AsyncStorage.removeItem(SESSION_KEY);
  }, []);

  const toggleOnline = useCallback(() => setOnline((value) => !value), []);

  const syncPending = useCallback(() => {
    setTransactions((current) =>
      current.map((transaction) =>
        transaction.status === 'PENDING SYNC'
          ? { ...transaction, status: 'SUCCESS' }
          : transaction,
      ),
    );
  }, []);

  const createPaymentRequest = useCallback((amount: number, auth: TransactionAuth): PaymentRequest | null => {
    // Require PIN or biometric authorization for payment request creation
    if (!authorize(auth)) {
      return null;
    }
    const request: PaymentRequest = {
      token: `tok_${makeId()}_pm`,
      amount,
      expiresAt: Date.now() + 60_000,
    };
    setPaymentRequest(request);
    return request;
  }, [storedPin]);

  const completePayment = useCallback(
    (amount: number, source: 'QR' | 'DEMO' = 'QR', auth?: TransactionAuth): boolean => {
      // Require PIN or biometric authorization for transactions
      if (!authorize(auth)) {
        return false;
      }
      const safeAmount = Math.round(amount * 100) / 100;
      if (safeAmount <= 0 || safeAmount > buyerBalance) return false;
      const transaction: Transaction = {
        id: makeId(),
        kind: 'MERCHANT_PAY',
        title: source === 'QR' ? 'Customer payment' : 'Demo customer payment',
        subtitle: online ? 'QR payment · Just now' : 'QR payment · Saved offline',
        amount: safeAmount,
        status: online ? 'SUCCESS' : 'PENDING SYNC',
        createdAt: Date.now(),
        direction: 'in',
      };
      setBuyerBalance((value) => Math.round((value - safeAmount) * 100) / 100);
      setMerchantBalance((value) => Math.round((value + safeAmount) * 100) / 100);
      setTransactions((current) => [transaction, ...current]);
      setPaymentRequest(null);
      return true;
    },
    [buyerBalance, online, storedPin],
  );

  const vendVas = useCallback(
    (kind: 'VAS_ELEC' | 'VAS_AIRTIME', amount: number, destination: string, auth: TransactionAuth): string | null => {
      // Require PIN or biometric authorization for transactions
      if (!authorize(auth)) {
        return 'INVALID_PIN';
      }
      const safeAmount = Math.round(amount * 100) / 100;
      if (!destination.trim() || safeAmount <= 0 || safeAmount > buyerBalance) return null;
      const transaction: Transaction = {
        id: makeId(),
        kind,
        title: kind === 'VAS_ELEC' ? 'Electricity token' : 'Airtime vending',
        subtitle: destination,
        amount: safeAmount,
        status: online ? 'SUCCESS' : 'PENDING SYNC',
        createdAt: Date.now(),
        direction: 'out',
      };
      setBuyerBalance((value) => Math.round((value - safeAmount) * 100) / 100);
      setTransactions((current) => [transaction, ...current]);
      if (kind === 'VAS_ELEC') {
        return Array.from({ length: 20 }, (_, index) => ((safeAmount * 13 + index * 17 + destination.length * 7) % 10)).join('');
      }
      return 'SUCCESS';
    },
    [buyerBalance, online, storedPin],
  );

  const cashOut = useCallback(
    (amount: number, auth: TransactionAuth) => {
      // Require PIN or biometric authorization for transactions
      if (!authorize(auth)) {
        return false;
      }
      const safeAmount = Math.round(amount * 100) / 100;
      if (safeAmount <= 0 || safeAmount > merchantBalance) return false;
      const transaction: Transaction = {
        id: makeId(),
        kind: 'CASH_OUT',
        title: 'Cash out',
        subtitle: 'Merchant wallet',
        amount: safeAmount,
        status: online ? 'SUCCESS' : 'PENDING SYNC',
        createdAt: Date.now(),
        direction: 'out',
      };
      setMerchantBalance((value) => Math.round((value - safeAmount) * 100) / 100);
      setTransactions((current) => [transaction, ...current]);
      return true;
    },
    [merchantBalance, online, storedPin],
  );

  const updateBusinessCategory = useCallback((category: BusinessCategory) => {
    setBusinessCategory(category);
    setProfile((current) =>
      current.accountType === 'business'
        ? { ...current, businessCategory: category }
        : current,
    );
  }, []);

  const value = useMemo(
    () => ({
      ready,
      signedIn,
      isRegistered,
      buyerBalance,
      merchantBalance,
      transactions,
      online,
      paymentRequest,
      businessCategory,
      profile,
      biometricAvailable,
      biometricLabel,
      login,
      biometricLogin,
      verifyBiometrics,
      registerAccount,
      logout,
      toggleOnline,
      syncPending,
      createPaymentRequest,
      completePayment,
      vendVas,
      cashOut,
      setBusinessCategory: updateBusinessCategory,
    }),
    [
      ready,
      signedIn,
      isRegistered,
      buyerBalance,
      merchantBalance,
      transactions,
      online,
      paymentRequest,
      businessCategory,
      profile,
      biometricAvailable,
      biometricLabel,
      login,
      biometricLogin,
      verifyBiometrics,
      registerAccount,
      logout,
      toggleOnline,
      syncPending,
      createPaymentRequest,
      completePayment,
      vendVas,
      cashOut,
      updateBusinessCategory,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet must be used inside WalletProvider');
  return value;
}