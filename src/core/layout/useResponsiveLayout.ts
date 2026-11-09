import { useWindowDimensions } from 'react-native';
import { getResponsiveLayout, type ScreenVariant } from './responsive';
export function useResponsiveLayout(variant: ScreenVariant = 'standard') {
  const { width, height } = useWindowDimensions();
  return getResponsiveLayout(width, height, variant);
}
