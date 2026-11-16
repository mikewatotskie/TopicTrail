import { useFonts } from 'expo-font';

export function useAppFonts() {
  return useFonts({
    Inter: require('../../assets/fonts/Inter-Regular.ttf'),
    InterMedium: require('../../assets/fonts/Inter-Medium.ttf'),
    InterSemiBold: require('../../assets/fonts/Inter-SemiBold.ttf'),
    InterBold: require('../../assets/fonts/Inter-Bold.ttf'),
  });
}
