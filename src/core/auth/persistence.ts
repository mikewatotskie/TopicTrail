import { inMemoryPersistence } from 'firebase/auth';

// Native session policy is unchanged; browser persistence is selected by the .web adapter.
export const authPersistence = inMemoryPersistence;
