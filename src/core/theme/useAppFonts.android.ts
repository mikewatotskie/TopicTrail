// MainApplication registers the immutable APK font before React starts.
export function useAppFonts(): [boolean, Error | null] {
  return [true, null];
}
