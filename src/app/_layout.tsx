import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAppFonts } from '../core/theme/useAppFonts';
import { ThemeProvider, useTheme } from '../core/theme/ThemeContext';
import { StudySelectionProvider } from '../features/reader/StudySelectionContext';
import { AppViewport } from '../core/layout/AppViewport';
import {UploadSessionProvider} from '../features/upload/UploadSessionContext';
import { AuthProvider } from '../features/auth/AuthContext';
import { CloudLibraryProvider } from '../features/library/CloudLibraryProvider';
import { getCloudLibrary } from '../core/services/document_storage';
import { NotesProvider } from '../features/notes/NotesProvider';

function AppStack() {
  const { colors, colorScheme, isInitialized } = useTheme();
  if (!isInitialized) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.canvas }}><ActivityIndicator color={colors.link} /></View>;
  return <StudySelectionProvider>
    <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="topic-preview" options={{ presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }} />
    </Stack>
  </StudySelectionProvider>;
}
export default function RootLayout() {
  const [library]=React.useState(getCloudLibrary);
  const [loaded, error] = useAppFonts();
  if (error) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}><Text>Unable to load the bundled fonts. Please restart TopicTrail.</Text></View>;
  if (!loaded) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator /></View>;
  return <AppViewport><ThemeProvider><AuthProvider><CloudLibraryProvider runtime={library}><NotesProvider><UploadSessionProvider><AppStack /></UploadSessionProvider></NotesProvider></CloudLibraryProvider></AuthProvider></ThemeProvider></AppViewport>;
}
