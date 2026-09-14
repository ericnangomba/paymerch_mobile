/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    text: '#111111',
    tint: '#111111',
    background: '#FBFBFA',
    foreground: '#111111',
    card: '#FFFFFF',
    cardForeground: '#111111',
    primary: '#111111',
    primaryForeground: '#FFFFFF',
    secondary: '#F1F1EF',
    secondaryForeground: '#111111',
    muted: '#F5F5F3',
    mutedForeground: '#71716D',
    accent: '#E9F8F1',
    accentForeground: '#087A4C',
    button: '#0D5A5A',
    buttonForeground: '#FFFFFF',
    destructive: '#D94841',
    destructiveForeground: '#FFFFFF',
    border: '#E7E7E3',
    input: '#E0E0DB',
    success: '#10B981',
    warning: '#F59E0B',
    dark: '#0A0A0A',
    darkMuted: '#1B1B1B',
    warm: '#F7F3E8',
  },
  dark: {
    text: '#FFFFFF',
    tint: '#FFFFFF',
    background: '#0A0A0A',
    foreground: '#FFFFFF',
    card: '#18181B',
    cardForeground: '#FFFFFF',
    primary: '#FFFFFF',
    primaryForeground: '#0A0A0A',
    secondary: '#27272A',
    secondaryForeground: '#FFFFFF',
    muted: '#202023',
    mutedForeground: '#A1A1AA',
    accent: '#123B2B',
    accentForeground: '#6EE7B7',
    button: '#1E7A6E',
    buttonForeground: '#FFFFFF',
    destructive: '#F87171',
    destructiveForeground: '#18181B',
    border: '#2B2B2F',
    input: '#3F3F46',
    success: '#34D399',
    warning: '#FBBF24',
    dark: '#FFFFFF',
    darkMuted: '#27272A',
    warm: '#29271F',
  },
  radius: 16,
};

export default colors;
