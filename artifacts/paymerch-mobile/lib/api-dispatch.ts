// Routes API calls to the real pilot backend or the explicit on-device demo.
//
// Demo mode is opt-in only (entered from a signed-out state via an explicit
// user action in the wallet context). It is never enabled by a network
// failure: when the pilot backend is unreachable the app stays in pilot mode
// and shows itself as disconnected.
import {
  cashOut as clientCashOut,
  completePaymentRequest as clientCompletePaymentRequest,
  createPaymentRequest as clientCreatePaymentRequest,
  getPaymentRequest as clientGetPaymentRequest,
  getWallet as clientGetWallet,
  login as clientLogin,
  logout as clientLogout,
  register as clientRegister,
  verifyPin as clientVerifyPin,
  setAuthTokenGetter as clientSetAuthTokenGetter,
  setBaseUrl as clientSetBaseUrl,
  type AuthTokenGetter,
  type AmountRequest,
  type CompletePaymentBody,
  type CompletePaymentResponse,
  type LoginRequest,
  type OkResponse,
  type PaymentRequest,
  type PaymentRequestDetail,
  type AuthSession,
  type RegisterRequest,
  type VerifyPinRequest,
  type VerifyPinResult,
  type WalletState,
} from '@workspace/api-client-react';
import { demoApi } from './demo-api';

let demoMode = false;

export function setApiDemoMode(next: boolean): void {
  demoMode = next;
}

export function setBaseUrl(url: string | null): void {
  clientSetBaseUrl(url);
}

export function setAuthTokenGetter(getter: AuthTokenGetter | null): void {
  clientSetAuthTokenGetter(getter);
  demoApi.setAuthTokenGetter(getter);
}

export function register(req: RegisterRequest): Promise<AuthSession> {
  return demoMode ? demoApi.register(req) : clientRegister(req);
}

export function login(req: LoginRequest): Promise<AuthSession> {
  return demoMode ? demoApi.login(req) : clientLogin(req);
}

export function logout(): Promise<OkResponse> {
  return demoMode ? demoApi.logout() : clientLogout();
}

export function verifyPin(req: VerifyPinRequest): Promise<VerifyPinResult> {
  return demoMode ? demoApi.verifyPin(req) : clientVerifyPin(req);
}

export function getWallet(): Promise<WalletState> {
  return demoMode ? demoApi.getWallet() : clientGetWallet();
}

export function createPaymentRequest(req: AmountRequest): Promise<PaymentRequest> {
  return demoMode ? demoApi.createPaymentRequest(req) : clientCreatePaymentRequest(req);
}

export function getPaymentRequest(token: string): Promise<PaymentRequestDetail> {
  return demoMode ? demoApi.getPaymentRequest(token) : clientGetPaymentRequest(token);
}

export function completePaymentRequest(
  token: string,
  body: CompletePaymentBody,
): Promise<CompletePaymentResponse> {
  return demoMode ? demoApi.completePaymentRequest(token, body) : clientCompletePaymentRequest(token, body);
}

export function cashOut(req: AmountRequest): Promise<WalletState> {
  return demoMode ? demoApi.cashOut(req) : clientCashOut(req);
}
