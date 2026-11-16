import React from 'react';
import {ScrollView} from 'react-native';
import {TTScreen} from '../../components';
import {TTAppBar} from '../../navigation';
import {useResponsiveLayout} from '../../core/layout/useResponsiveLayout';
import {useCloudLibrary} from '../library/CloudLibraryContext';
import {NotesPanel} from './NotesPanel';

export function NotesScreen(){const {gutter}=useResponsiveLayout();const {state}=useCloudLibrary();return <TTScreen><TTAppBar title="Notebook"/><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:gutter,gap:16}}><NotesPanel key={state.epoch} startNew/></ScrollView></TTScreen>;}
export default NotesScreen;
