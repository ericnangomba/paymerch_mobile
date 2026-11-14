const tintColorLight = '#A0630A';
const tintColorDark = '#E9A820';

// Stokvel Gold brand palette:
//   ink   #211A12  warm off-black, used for text and dark surfaces
//   gold  #E9A820  primary action colour
//   cream #F8F1E2  page background
//   leaf  #3E6B35  success
//   punch #C23B2E  destructive

export default {
  light: {
    text: '#181410',
    foreground: '#181410',
    tint: tintColorLight,
    background: '#F8F1E2',
    card: '#FFFFFF',
    cardForeground: '#181410',
    primary: '#E9A820',
    primaryForeground: '#211A12',
    secondary: '#F1E7CE',
    secondaryForeground: '#181410',
    muted: '#EFE6CF',
    mutedForeground: '#5F594D',
    accent: '#F6E9C4',
    accentForeground: '#6B4E0A',
    button: '#E9A820',
    buttonForeground: '#211A12',
    active: '#E9A820',
    activeForeground: '#211A12',
    destructive: '#C23B2E',
    destructiveForeground: '#FFFFFF',
    border: '#E3DCC8',
    input: '#E3DCC8',
    success: '#3E6B35',
    warning: '#A0630A',
    dark: '#211A12',
    darkMuted: '#4A3F2C',
    warm: '#F5E7C2',
  },
  dark: {
    text: '#F8F1E2',
    foreground: '#F8F1E2',
    tint: tintColorDark,
    background: '#211A12',
    card: '#2E2616',
    cardForeground: '#F8F1E2',
    primary: '#E9A820',
    primaryForeground: '#211A12',
    secondary: '#3A2F1C',
    secondaryForeground: '#F8F1E2',
    muted: '#352B18',
    mutedForeground: '#C9B98F',
    accent: '#3D3115',
    accentForeground: '#E9C25C',
    button: '#E9A820',
    buttonForeground: '#211A12',
    active: '#E9A820',
    activeForeground: '#211A12',
    destructive: '#E0604F',
    destructiveForeground: '#211A12',
    border: '#4A3D24',
    input: '#4A3D24',
    success: '#7DBA6F',
    warning: '#E9A820',
    dark: '#161009',
    darkMuted: '#C9B98F',
    warm: '#3D3115',
  },
  radius: 16,
};
