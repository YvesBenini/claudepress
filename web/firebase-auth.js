// Sign-in through Firebase Authentication (email + password, Google, GitHub). The server only receives the ID token
// once, checks it, and opens its own session; Firebase keeps the passwords and sends the e-mails.
import { currentLang } from './i18n.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
let ready = null;

async function load(config) {
  ready ||= (async () => {
    const [{ initializeApp }, auth] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]);
    const app = initializeApp(config);
    const a = auth.getAuth(app);
    if (config.authEmulator) auth.connectAuthEmulator(a, config.authEmulator, { disableWarnings: true });   // local tests only
    a.languageCode = currentLang();   // confirmation and password-reset e-mails in the person's language
    return { a, ...auth };
  })();
  return ready;
}

const MESSAGES = {
  'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
  'auth/wrong-password': 'E-mail ou mot de passe incorrect.',
  'auth/user-not-found': 'E-mail ou mot de passe incorrect.',
  'auth/email-already-in-use': 'Un compte existe déjà avec cet e-mail : connectez-vous (ou utilisez « Mot de passe oublié »).',
  'auth/weak-password': 'Mot de passe trop faible : au moins 10 caractères.',
  'auth/invalid-email': 'Adresse e-mail invalide.',
  'auth/too-many-requests': 'Trop de tentatives. Réessayez dans quelques minutes.',
  'auth/popup-closed-by-user': 'Fenêtre de connexion fermée avant la fin.',
  'auth/popup-blocked': 'Le navigateur a bloqué la fenêtre de connexion : autorisez les fenêtres pour ce site.',
  'auth/account-exists-with-different-credential': 'Un compte existe déjà avec cette adresse e-mail : entrez avec Google ou votre mot de passe.',
  'auth/operation-not-allowed': 'Cette façon de se connecter n’est pas activée sur ce serveur.',
  'auth/network-request-failed': 'Pas de connexion. Vérifiez votre réseau.',
};
export const authMessage = e => MESSAGES[e?.code] || e?.message || 'Connexion impossible.';

export async function withGoogle(config) {
  const f = await load(config);
  const provider = new f.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return (await f.signInWithPopup(f.a, provider)).user;
}

export async function withGitHub(config) {
  const f = await load(config);
  const provider = new f.GithubAuthProvider();
  provider.addScope('user:email');   // the address, even when the GitHub profile keeps it private
  return (await f.signInWithPopup(f.a, provider)).user;
}

export async function withPassword(config, email, password) {
  const f = await load(config);
  return (await f.signInWithEmailAndPassword(f.a, email, password)).user;
}

export async function createWithPassword(config, email, password, name) {
  const f = await load(config);
  const { user } = await f.createUserWithEmailAndPassword(f.a, email, password);
  if (name) await f.updateProfile(user, { displayName: name });
  return user;
}

export async function sendVerification(config, user) {
  const f = await load(config);
  await f.sendEmailVerification(user, { url: location.origin + '/#/login' });
}

export async function resetPassword(config, email) {
  const f = await load(config);
  await f.sendPasswordResetEmail(f.a, email, { url: location.origin + '/#/login' });
}

/** The current Firebase user, reloaded so a just-confirmed e-mail counts. */
export async function currentUser(config) {
  const f = await load(config);
  await f.a.authStateReady();
  if (f.a.currentUser) await f.a.currentUser.reload();
  return f.a.currentUser;
}

export async function signOutFirebase(config) {
  if (!config) return;
  const f = await load(config);
  await f.signOut(f.a);
}
