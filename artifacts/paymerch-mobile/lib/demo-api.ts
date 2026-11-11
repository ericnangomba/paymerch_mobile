// Wires the on-device demo API to AsyncStorage. The pure logic lives in
// demo-store.ts so it can be unit-tested without React Native imports.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createDemoApi, DEMO_PIN } from './demo-store';

export const demoApi = createDemoApi(AsyncStorage);
export { DEMO_PIN };
