/**
 * TopicTrail Design Tokens
 * 
 * Centralized design tokens extracted from Figma Design System (Page 04).
 * These tokens define the visual language of the app including colors,
 * spacing, typography, border radius, and effects.
 * 
 * Source: Figma file v3Lh2OqRQpqQZakCyHPigf, Page "04 · Design system" (2:4)
 * Verified: 2026-10-24
 */



/**
 * Color tokens for Light theme
 */
export const TTLightColors = {
  /** Primary brand blue - #003399 */
  brand: '#003399',
  
  /** Pressed state for brand color - #00266F */
  brandPressed: '#00266F',
  
  /** Light canvas/background - #F5F5F5 */
  canvas: '#F5F5F5',
  
  /** Primary text color - #13213B */
  ink: '#13213B',
  
  /** Text on brand background - #FFFFFF */
  onBrand: '#FFFFFF',
  
  /** Yellow accent for Study action - #FFCC00 */
  accent: '#FFCC00',
  
  /** Text on yellow accent - #151B26 */
  onAccent: '#151B26',
  
  /** White - #FFFFFF */
  white: '#FFFFFF',
  
  /** Muted text - #52627A */
  muted: '#52627A',
  
  /** Soft blue background - #E7EEFF */
  soft: '#E7EEFF',
  
  /** Border color - #718096 */
  border: '#718096',
  
  /** Navy (same as ink in light) - #13213B */
  navy: '#13213B',
  
  /** Danger/error red - #B42335 */
  danger: '#B42335',
  
  /** Text on danger - #FFFFFF */
  onDanger: '#FFFFFF',
  
  /** Danger soft background - #FFF0F1 */
  dangerSoft: '#FFF0F1',
  
  /** Warning amber - #805600 */
  warning: '#805600',
  
  /** Warning soft background - #FFF3CC */
  warningSoft: '#FFF3CC',
  
  /** Highlight background - #E7EEFF */
  highlight: '#E7EEFF',
  
  /** Link color - #003399 */
  link: '#003399',
  
  /** Surface/card background - #FFFFFF */
  surface: '#FFFFFF',
  
  /** Sky blue aura opacity (42%) */
  auraSkyOpacity: 42,
  
  /** Royal blue aura opacity (25%) */
  auraRoyalOpacity: 25,
} as const;

/**
 * Color tokens for Dark theme
 */
export const TTDarkColors = {
  /** Primary brand blue - #003399 (same in both themes) */
  brand: '#003399',
  
  /** Dark canvas/background - #0B1220 */
  canvas: '#0B1220',
  
  /** Primary text color (light) - #F5F7FC */
  ink: '#F5F7FC',
  
  /** Text on brand background - #FFFFFF */
  onBrand: '#FFFFFF',
  
  /** Yellow accent for Study action - #FFCC00 (same in both themes) */
  accent: '#FFCC00',
  
  /** Text on yellow accent - #151B26 (same in both themes) */
  onAccent: '#151B26',
  
  /** Muted text - #B8C5D8 */
  muted: '#B8C5D8',
  
  /** Border color - #627897 */
  border: '#627897',
  
  /** Highlight background - #18366D */
  highlight: '#18366D',
  
  /** Warning amber (lighter) - #FFE08A */
  warning: '#FFE08A',
  
  /** Surface/card background - #111D32 */
  surface: '#111D32',
} as const;

/**
 * Spacing tokens based on 8-point grid
 */
export const TTSpacing = {
  space0: 0,
  space4: 4,
  space6: 6,
  space8: 8,
  space12: 12,
  space16: 16,
  space20: 20,
  space24: 24,
  space32: 32,
  space40: 40,
  space48: 48,
  space64: 64,
} as const;

/**
 * Border radius tokens
 */
export const TTRadius = {
  radiusSm: 8,
  radiusMd: 12,
  radiusLg: 24,
  radiusFull: 999,
} as const;

/**
 * Typography tokens using Inter font family
 */
export const TTTypography = {
  fontFamily: 'Inter',
  
  /** Display: Bold 36px, lineHeight 44 */
  display: {
    fontFamily: 'InterBold',
    fontSize: 36,
    fontWeight: '700' as const,
    lineHeight: 44,
    letterSpacing: 0,
  },
  
  /** Heading: Bold 24px, lineHeight 32 */
  heading: {
    fontFamily: 'InterBold',
    fontSize: 24,
    fontWeight: '700' as const,
    lineHeight: 32,
    letterSpacing: 0,
  },
  
  /** Section: SemiBold 18px, lineHeight 24 */
  section: {
    fontFamily: 'InterSemiBold',
    fontSize: 18,
    fontWeight: '600' as const,
    lineHeight: 24,
    letterSpacing: 0,
  },
  
  /** Title: SemiBold 20px, lineHeight 28 */
  title: {
    fontFamily: 'InterSemiBold',
    fontSize: 20,
    fontWeight: '600' as const,
    lineHeight: 28,
    letterSpacing: 0,
  },
  
  /** Button: SemiBold 16px, lineHeight 24 */
  button: {
    fontFamily: 'InterSemiBold',
    fontSize: 16,
    fontWeight: '600' as const,
    lineHeight: 24,
    letterSpacing: 0,
  },
  
  /** Body Strong: SemiBold 16px, lineHeight 24 */
  bodyStrong: {
    fontFamily: 'InterSemiBold',
    fontSize: 16,
    fontWeight: '600' as const,
    lineHeight: 24,
    letterSpacing: 0,
  },
  
  /** Body: Regular 16px, lineHeight 24 */
  body: {
    fontFamily: 'Inter',
    fontSize: 16,
    fontWeight: '400' as const,
    lineHeight: 24,
    letterSpacing: 0,
  },
  
  /** Small Strong: SemiBold 14px, lineHeight 20 */
  smallStrong: {
    fontFamily: 'InterSemiBold',
    fontSize: 14,
    fontWeight: '600' as const,
    lineHeight: 20,
    letterSpacing: 0,
  },
  
  /** Small: Regular 14px, lineHeight 20 */
  small: {
    fontFamily: 'Inter',
    fontSize: 14,
    fontWeight: '400' as const,
    lineHeight: 20,
    letterSpacing: 0,
  },
  
  /** Caption: Medium 12px, lineHeight 16 */
  caption: {
    fontFamily: 'InterMedium',
    fontSize: 12,
    fontWeight: '500' as const,
    lineHeight: 16,
    letterSpacing: 0,
  },
} as const;

/**
 * Shadow and blur effects
 */
export const TTEffects = {
  /** Overlay shadow: Drop shadow with color #1D2B531F, offset (0, 8), radius 24 */
  overlayShadow: {
    shadowColor: '#1D2B53',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 8,
  },
  
  /** Feature aura blur radius */
  auraBlurFeature: 32,
  
  /** Quiet aura blur radius */
  auraBlurQuiet: 28,
  
  /** Header aura blur radius */
  auraBlurHeader: 22,
} as const;

/**
 * Document format types
 */
export { DocumentFormat } from '../models/document';

/**
 * Resource status types
 */
export enum ResourceStatus {
  SCREENED = 'screened',
  CHECKING = 'checking',
  UNKNOWN = 'unknown',
  BLOCKED = 'blocked',
  PARTIAL = 'partial',
}

/**
 * Notice types
 */
export enum NoticeType {
  INFO = 'info',
  ERROR = 'error',
  SUCCESS = 'success',
}

/**
 * Button variant types
 */
export enum ButtonVariant {
  PRIMARY = 'primary',
  SECONDARY = 'secondary',
  GHOST = 'ghost',
  STUDY = 'study',
  DANGER = 'danger',
}

/**
 * Button size variants
 */
export enum ButtonSize {
  REGULAR = 'regular',
  COMPACT = 'compact',
  FULL_WIDTH = 'fullWidth',
}

/**
 * Navigation destinations
 */
export enum NavDestination {
  HOME = 'home',
  MY_SYLLABI = 'mySyllabi',
  SAVED = 'saved',
  SETTINGS = 'settings',
}

/**
 * Theme mode preference
 */
export enum ThemeMode {
  SYSTEM = 'system',
  LIGHT = 'light',
  DARK = 'dark',
}
