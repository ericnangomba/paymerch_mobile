import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  cashOut as apiCashOut,
  completePaymentRequest as apiCompletePaymentRequest,
  createPaymentRequest as apiCreatePaymentRequest,
  getPaymentRequest as apiGetPaymentRequest,
  getWallet as apiGetWallet,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  setApiDemoMode,
  setAuthTokenGetter,
  setBaseUrl,
  verifyPin as apiVerifyPin,
} from '../lib/api-dispatch';
import { demoApi, DEMO_PIN } from '../lib/demo-api';
import type { Profile as ApiProfile, WalletState } from '@workspace/api-client-react';

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

// The pilot never collects bank details: balances are test money on the
// pilot server and cash-out is a simulated ledger entry, not a bank payout.
export type UserProfile = {
  accountType: AccountType;
  name: string;
  phone: string;
  businessCategory?: BusinessCategory;
};

export type Transaction = {
  id: string;
  reference?: string;
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

// Server-side view of a payment request, fetched by the merchant after
// scanning. The server is the source of truth for amount and payer; the QR
// payload alone is never trusted.
export type PaymentRequestPreview = {
  token: string;
  amount: number;
  expiresAt: number;
  payerName: string;
  status: 'OPEN' | 'COMPLETED' | 'EXPIRED';
};

export type ReauthAction = 'create-payment-request' | 'complete-payment' | 'cash-out';

export type CompletePaymentResult =
  | 'SUCCESS'
  | 'INVALID_AUTH'
  | 'INVALID_REQUEST'
  | 'EXPIRED'
  | 'INSUFFICIENT_BALANCE'
  | 'ALREADY_USED';

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
  registerAccount: (profile: UserProfile, pin: string) => Promise<boolean>;
  logout: () => Promise<void>;
  toggleOnline: () => void;
  syncPending: () => void;
  createPaymentRequest: (amount: number, pin: string) => Promise<PaymentRequest | null>;
  previewPaymentRequest: (token: string) => Promise<PaymentRequestPreview | null>;
  completePayment: (
    request: PaymentRequest,
    payerName: string,
    pin: string,
  ) => Promise<CompletePaymentResult>;
  vendVas: (kind: 'VAS_ELEC' | 'VAS_AIRTIME', amount: number, destination: string) => string | null;
  cashOut: (amount: number, pin: string) => Promise<boolean>;
  setBusinessCategory: (category: BusinessCategory) => void;
  demoMode: boolean;
  demoPin: string;
  enterDemoMode: () => Promise<void>;
  exitDemoMode: () => Promise<void>;
  switchDemoProfile: () => Promise<void>;
};

const SESSION_KEY = 'paymerch-session-v2';
const PROFILE_KEY = 'paymerch-profile-v2';
const WALLET_CACHE_KEY = 'paymerch-wallet-cache-v2';
// Demo mode stores under separate keys so a demo session can never read or
// overwrite a real (pilot server) session, profile, or cached wallet.
const DEMO_SESSION_KEY = 'paymerch-demo-session-v1';
const DEMO_PROFILE_KEY = 'paymerch-demo-profile-v1';
const DEMO_WALLET_CACHE_KEY = 'paymerch-demo-wallet-cache-v1';

function storageKeys(demo: boolean): { session: string; profile: string; wallet: string } {
  return demo
    ? { session: DEMO_SESSION_KEY, profile: DEMO_PROFILE_KEY, wallet: DEMO_WALLET_CACHE_KEY }
    : { session: SESSION_KEY, profile: PROFILE_KEY, wallet: WALLET_CACHE_KEY };
}

// The pilot API base URL. Set EXPO_PUBLIC_API_URL at build time (for example
// https://your-pilot-server.example.com). Empty means same-origin /api, which
// matches serving the web build and the API from one host.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

setBaseUrl(API_BASE_URL || null);

const WalletContext = createContext<WalletContextValue | null>(null);

function applyWalletState(
  wallet: WalletState,
  setters: {
    setBuyerBalance: (v: number) => void;
    setMerchantBalance: (v: number) => void;
    setTransactions: (v: Transaction[]) => void;
  },
) {
  setters.setBuyerBalance(wallet.buyerBalance);
  setters.setMerchantBalance(wallet.merchantBalance);
  setters.setTransactions(wallet.transactions as Transaction[]);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [buyerBalance, setBuyerBalance] = useState(0);
  const [merchantBalance, setMerchantBalance] = useState(0);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [online, setOnline] = useState(true);
  const [paymentRequest, setPaymentRequest] = useState<PaymentRequest | null>(null);
  const [businessCategory, setBusinessCategory] = useState<BusinessCategory>('Spaza shop');
  const [profile, setProfile] = useState<UserProfile>({
    accountType: 'business',
    name: '',
    phone: '',
  });
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState('Use biometrics');
  const sessionTokenRef = useRef<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    setAuthTokenGetter(() => sessionTokenRef.current);
    return () => setAuthTokenGetter(null);
  }, []);

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

  const cacheWallet = useCallback(
    async (wallet: WalletState) => {
      await AsyncStorage.setItem(storageKeys(demoMode).wallet, JSON.stringify(wallet));
    },
    [demoMode],
  );

  const acceptSession = useCallback(
    async (session: { sessionToken: string; profile: ApiProfile; wallet: WalletState }) => {
      const keys = storageKeys(demoMode);
      sessionTokenRef.current = session.sessionToken;
      await AsyncStorage.setItem(keys.session, session.sessionToken);
      const nextProfile = session.profile as UserProfile;
      setProfile(nextProfile);
      if (nextProfile.businessCategory) setBusinessCategory(nextProfile.businessCategory);
      await AsyncStorage.setItem(keys.profile, JSON.stringify(nextProfile));
      applyWalletState(session.wallet, { setBuyerBalance, setMerchantBalance, setTransactions });
      await cacheWallet(session.wallet);
      setIsRegistered(true);
      setSignedIn(true);
      setOnline(true);
    },
    [cacheWallet, demoMode],
  );

  const clearSession = useCallback(async () => {
    sessionTokenRef.current = null;
    await AsyncStorage.removeItem(storageKeys(demoMode).session);
    setSignedIn(false);
  }, [demoMode]);

  // Refresh balances and activity from the pilot server. Marks the app
  // disconnected when the server cannot be reached; cached values stay
  // visible but no transaction can be confirmed while offline.
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!sessionTokenRef.current) return false;
    try {
      const wallet = await apiGetWallet();
      applyWalletState(wallet, { setBuyerBalance, setMerchantBalance, setTransactions });
      await cacheWallet(wallet);
      setOnline(true);
      return true;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        await clearSession();
        return false;
      }
      setOnline(false);
      return false;
    }
  }, [cacheWallet, clearSession]);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const [token, profileRaw, walletRaw, demoToken, demoProfileRaw, demoWalletRaw] = await Promise.all([
        AsyncStorage.getItem(SESSION_KEY),
        AsyncStorage.getItem(PROFILE_KEY),
        AsyncStorage.getItem(WALLET_CACHE_KEY),
        AsyncStorage.getItem(DEMO_SESSION_KEY),
        AsyncStorage.getItem(DEMO_PROFILE_KEY),
        AsyncStorage.getItem(DEMO_WALLET_CACHE_KEY),
      ]);
      if (cancelled) return;
      // A live server session always wins; demo mode only resumes when no
      // server session exists, and is otherwise left dormant and untouched.
      const resumeDemo = !token && !!demoToken;
      if (resumeDemo) {
        setApiDemoMode(true);
        setDemoMode(true);
      }
      if (!resumeDemo && profileRaw) {
        try {
          const stored = JSON.parse(profileRaw) as UserProfile;
          setProfile(stored);
          if (stored.businessCategory) setBusinessCategory(stored.businessCategory);
          setIsRegistered(true);
        } catch {
          await AsyncStorage.removeItem(PROFILE_KEY);
        }
      }
      if (!resumeDemo && walletRaw) {
        try {
          const cached = JSON.parse(walletRaw) as WalletState;
          applyWalletState(cached, { setBuyerBalance, setMerchantBalance, setTransactions });
        } catch {
          await AsyncStorage.removeItem(WALLET_CACHE_KEY);
        }
      }
      if (resumeDemo && demoProfileRaw) {
        try {
          const stored = JSON.parse(demoProfileRaw) as UserProfile;
          setProfile(stored);
          if (stored.businessCategory) setBusinessCategory(stored.businessCategory);
          setIsRegistered(true);
        } catch {
          await AsyncStorage.removeItem(DEMO_PROFILE_KEY);
        }
      }
      if (resumeDemo && demoWalletRaw) {
        try {
          const cached = JSON.parse(demoWalletRaw) as WalletState;
          applyWalletState(cached, { setBuyerBalance, setMerchantBalance, setTransactions });
        } catch {
          await AsyncStorage.removeItem(DEMO_WALLET_CACHE_KEY);
        }
      }
      const activeToken = token || (resumeDemo ? demoToken : null);
      if (activeToken) {
        sessionTokenRef.current = activeToken;
        setSignedIn(true);
        // Confirm the session and pull fresh state; failure marks the app
        // disconnected rather than confirming anything stale.
        void refresh();
      }
      setReady(true);
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const login = useCallback(
    async (pin: string): Promise<boolean> => {
      const phone = profile.phone;
      if (!phone) return false;
      try {
        const session = await apiLogin({ phone, pin });
        await acceptSession(session);
        return true;
      } catch {
        return false;
      }
    },
    [profile.phone, acceptSession],
  );

  const biometricLogin = useCallback(async () => {
    // Biometrics unlock the existing server session on this device; they never
    // create a session by themselves.
    if (sessionTokenRef.current) {
      setSignedIn(true);
      void refresh();
    }
  }, [refresh]);

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

  // Re-verifies the account PIN against the pilot server and returns a
  // single-use, short-lived token bound to one specific action. The money
  // endpoints reject calls without it, so a PIN check can never authorize
  // anything other than the intended action. Biometrics unlock the app but
  // never authorize money movement.
  const requestReauth = useCallback(async (pin: string, action: ReauthAction): Promise<string | null> => {
    try {
      const result = await apiVerifyPin({ pin, action });
      return result.ok && result.reauthToken ? result.reauthToken : null;
    } catch {
      return null;
    }
  }, []);

  const registerAccount = useCallback(
    async (nextProfile: UserProfile, pin: string): Promise<boolean> => {
      try {
        const session = await apiRegister({ ...nextProfile, pin });
        await acceptSession(session);
        return true;
      } catch {
        return false;
      }
    },
    [acceptSession],
  );

  // Explicit opt-in demo mode: only from a signed-out state, never as a
  // reaction to a network failure, and never over a live server session.
  const enterDemoMode = useCallback(async () => {
    if (signedIn || sessionTokenRef.current) return;
    setApiDemoMode(true);
    setDemoMode(true);
    const demoProfile = (await demoApi.prepareDemo()) as UserProfile;
    setProfile(demoProfile);
    if (demoProfile.businessCategory) setBusinessCategory(demoProfile.businessCategory);
    await AsyncStorage.setItem(DEMO_PROFILE_KEY, JSON.stringify(demoProfile));
    setIsRegistered(true);
    setSignedIn(false);
    setOnline(true);
    setPaymentRequest(null);
  }, [signedIn]);

  const exitDemoMode = useCallback(async () => {
    try {
      await demoApi.logout();
    } catch {
      // Local sign-out still proceeds.
    }
    sessionTokenRef.current = null;
    await AsyncStorage.removeItem(DEMO_SESSION_KEY);
    await AsyncStorage.removeItem(DEMO_WALLET_CACHE_KEY);
    setApiDemoMode(false);
    setDemoMode(false);
    setSignedIn(false);
    setPaymentRequest(null);
    setBuyerBalance(0);
    setMerchantBalance(0);
    setTransactions([]);
    // Restore any stored server profile so the pilot auth screen returns to
    // its previous state; server storage was never touched while in demo.
    const profileRaw = await AsyncStorage.getItem(PROFILE_KEY);
    if (profileRaw) {
      try {
        const stored = JSON.parse(profileRaw) as UserProfile;
        setProfile(stored);
        if (stored.businessCategory) setBusinessCategory(stored.businessCategory);
        setIsRegistered(true);
        return;
      } catch {
        await AsyncStorage.removeItem(PROFILE_KEY);
      }
    }
    setProfile({ accountType: 'business', name: '', phone: '' });
    setIsRegistered(false);
  }, []);

  const switchDemoProfile = useCallback(async () => {
    if (!demoMode) return;
    try {
      await demoApi.logout();
    } catch {
      // Local sign-out still proceeds.
    }
    sessionTokenRef.current = null;
    await AsyncStorage.removeItem(DEMO_SESSION_KEY);
    await AsyncStorage.removeItem(DEMO_WALLET_CACHE_KEY);
    setSignedIn(false);
    setBuyerBalance(0);
    setMerchantBalance(0);
    setTransactions([]);
    const next = (await demoApi.otherDemoProfile(profile.phone)) as UserProfile;
    setProfile(next);
    if (next.businessCategory) setBusinessCategory(next.businessCategory);
    await AsyncStorage.setItem(DEMO_PROFILE_KEY, JSON.stringify(next));
  }, [demoMode, profile.phone]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // Local sign-out still proceeds when the server cannot be reached.
    }
    await clearSession();
  }, [clearSession]);

  const toggleOnline = useCallback(() => {
    setOnline((value) => {
      const next = !value;
      if (next) void refresh();
      return next;
    });
  }, [refresh]);

  const syncPending = useCallback(() => {
    void refresh();
  }, [refresh]);

  const createPaymentRequest = useCallback(
    async (amount: number, pin: string): Promise<PaymentRequest | null> => {
      if (!online) return null;
      if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) > Math.round(buyerBalance * 100)) {
        return null;
      }
      const reauthToken = await requestReauth(pin, 'create-payment-request');
      if (!reauthToken) return null;
      try {
        const request = await apiCreatePaymentRequest({ amount: Math.round(amount * 100) / 100, reauthToken });
        const mapped: PaymentRequest = {
          token: request.token,
          amount: request.amount,
          expiresAt: request.expiresAt,
        };
        setPaymentRequest(mapped);
        return mapped;
      } catch {
        return null;
      }
    },
    [online, requestReauth, buyerBalance],
  );

  const previewPaymentRequest = useCallback(
    async (token: string): Promise<PaymentRequestPreview | null> => {
      if (!online) return null;
      try {
        const detail = await apiGetPaymentRequest(token);
        return {
          token: detail.token,
          amount: detail.amount,
          expiresAt: detail.expiresAt,
          payerName: detail.payerName,
          status: detail.status,
        };
      } catch {
        return null;
      }
    },
    [online],
  );

  const completePayment = useCallback(
    async (
      request: PaymentRequest,
      _payerName: string,
      pin: string,
    ): Promise<CompletePaymentResult> => {
      if (!request || typeof request.token !== 'string' || request.token.length === 0) {
        return 'INVALID_REQUEST';
      }
      if (!online) return 'INVALID_REQUEST';
      const reauthToken = await requestReauth(pin, 'complete-payment');
      if (!reauthToken) return 'INVALID_AUTH';
      try {
        const response = await apiCompletePaymentRequest(request.token, { reauthToken });
        applyWalletState(response.wallet, { setBuyerBalance, setMerchantBalance, setTransactions });
        await cacheWallet(response.wallet);
        if (response.result === 'SUCCESS') {
          setPaymentRequest((current) => (current?.token === request.token ? null : current));
        }
        return response.result;
      } catch {
        return 'INVALID_REQUEST';
      }
    },
    [requestReauth, online, cacheWallet],
  );

  // VAS vending is not part of the pilot build; the screen is disabled in the UI.
  const vendVas = useCallback(
    (_kind: 'VAS_ELEC' | 'VAS_AIRTIME', _amount: number, _destination: string): string | null => null,
    [],
  );

  const cashOut = useCallback(
    async (amount: number, pin: string): Promise<boolean> => {
      if (!online) return false;
      const safeAmount = Math.round(amount * 100) / 100;
      if (safeAmount <= 0 || safeAmount > merchantBalance) return false;
      const reauthToken = await requestReauth(pin, 'cash-out');
      if (!reauthToken) return false;
      try {
        const wallet = await apiCashOut({ amount: safeAmount, reauthToken });
        applyWalletState(wallet, { setBuyerBalance, setMerchantBalance, setTransactions });
        await cacheWallet(wallet);
        return true;
      } catch {
        return false;
      }
    },
    [online, requestReauth, merchantBalance, cacheWallet],
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
      previewPaymentRequest,
      completePayment,
      vendVas,
      cashOut,
      setBusinessCategory: updateBusinessCategory,
      demoMode,
      demoPin: DEMO_PIN,
      enterDemoMode,
      exitDemoMode,
      switchDemoProfile,
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
      previewPaymentRequest,
      completePayment,
      vendVas,
      cashOut,
      updateBusinessCategory,
      demoMode,
      enterDemoMode,
      exitDemoMode,
      switchDemoProfile,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet must be used inside WalletProvider');
  return value;
}
