import { createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail,
  signInWithEmailAndPassword, signOut, updateProfile, type Auth } from 'firebase/auth';
import { createAuthGateway } from './gateway';
import { AuthOperationError, type AccountIdentity, type AuthGateway } from './types';

/** A real Firebase adapter. Its caller chooses Auth initialization/persistence explicitly. */
export function createFirebaseAuthGateway(auth: Auth): AuthGateway {
  return createAuthGateway({
    currentIdentity(): AccountIdentity | null {
      const user = auth.currentUser;
      return user ? { uid: user.uid, email: user.email, displayName: user.displayName, emailVerified: user.emailVerified } : null;
    },
    observe: (changed, failed) => onAuthStateChanged(auth, () => changed(), failed),
    async signIn(email, password) { await signInWithEmailAndPassword(auth, email, password); },
    async createAccount(email, password) { await createUserWithEmailAndPassword(auth, email, password); },
    async updateDisplayName(displayName) {
      if (!auth.currentUser) throw new AuthOperationError('unavailable', 'Account setup could not finish.');
      await updateProfile(auth.currentUser, { displayName });
    },
    sendPasswordReset: email => sendPasswordResetEmail(auth, email),
    signOut: () => signOut(auth),
  });
}
