// Firebase: the app, App Check (required by Firebase AI Logic), and the AI Logic service.
// The web config below is public by design; access is protected by App Check, not by hiding it.
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, GoogleAIBackend } from "firebase/ai";

const app = initializeApp({
  apiKey: "AIzaSyCsk-yVhTjdKMaeUFYt7X68XwRi4ttRGyQ",
  authDomain: "rajista-ai.firebaseapp.com",
  projectId: "rajista-ai",
  storageBucket: "rajista-ai.firebasestorage.app",
  messagingSenderId: "842188781934",
  appId: "1:842188781934:web:a8abac4e909ac6bfb0697f",
});

// For local testing only: an App Check debug token from .env.local (never committed).
// Judges and the live site use reCAPTCHA Enterprise instead.
const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined;
if (debugToken) (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;

initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider("6LfKDxsuAAAAAN9t-sQHG6BMbix8F00hHZVI7pLW"),
  isTokenAutoRefreshEnabled: true,
});

export const ai = getAI(app, { backend: new GoogleAIBackend() });
