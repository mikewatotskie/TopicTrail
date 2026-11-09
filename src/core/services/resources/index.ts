import { Platform } from 'react-native';
import { ResourceDiscoveryService } from './discovery';
import { WikipediaProvider } from './wikipedia';
export const resourceDiscovery = new ResourceDiscoveryService([new WikipediaProvider({ native: Platform.OS !== 'web' })]);
