import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { ThemeProvider, useTheme } from '../core/theme/ThemeContext';
import { StudySelectionProvider } from '../features/reader/StudySelectionContext';
import { AppViewport } from '../core/layout/AppViewport';
import {UploadSessionProvider} from '../features/upload/UploadSessionContext';
import { AuthProvider } from '../features/auth/AuthContext';

function AppStack() {
  const { colors, colorScheme, isInitialized } = useTheme();
  if (!isInitialized) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.canvas }}><ActivityIndicator color={colors.link} /></View>;
  return <StudySelectionProvider>
    <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }} />
  </StudySelectionProvider>;
}
export default function RootLayout() {
  const [loaded, error] = useFonts({ Inter: require('../assets/fonts/Inter-Regular.ttf'),
    InterMedium: require('../assets/fonts/Inter-Medium.ttf'), InterSemiBold: require('../assets/fonts/Inter-SemiBold.ttf'),
    InterBold: require('../assets/fonts/Inter-Bold.ttf') });
  if (error) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}><Text>Unable to load the bundled fonts. Please restart TopicTrail.</Text></View>;
  if (!loaded) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator /></View>;
  return <AppViewport><ThemeProvider><AuthProvider><UploadSessionProvider><AppStack /></UploadSessionProvider></AuthProvider></ThemeProvider></AppViewport>;
}
