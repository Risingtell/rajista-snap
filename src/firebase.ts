// Firebase: the app, App Check (required by Firebase AI Logic), and the AI Logic service.
// The web config comes from .env.local (see .env.example). A Firebase web key is not a password: it ships in every
// web page that uses Firebase. It is not stored in the source, and the live key is restricted to this app's sites
// and to the Firebase APIs it uses; App Check then decides which requests reach the AI.
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, GoogleAIBackend } from "firebase/ai";

const env = import.meta.env;
const need = (k: string) => {
  const v = env[k] as string | undefined;
  if (!v) throw new Error(`${k} is not set. Copy .env.example to .env.local and fill it in (see README).`);
  return v;
};

const app = initializeApp({
  apiKey: need("VITE_FIREBASE_API_KEY"),
  authDomain: `${need("VITE_FIREBASE_PROJECT_ID")}.firebaseapp.com`,
  projectId: need("VITE_FIREBASE_PROJECT_ID"),
  appId: need("VITE_FIREBASE_APP_ID"),
});

// For local testing only: an App Check debug token from .env.development.local (never committed). It is used only
// in development mode, so a production build drops it even if it is set by mistake; `npm run deploy` also refuses
// to publish a build that contains anything shaped like a token (scripts/check-dist.mjs). Judges and the live site
// use reCAPTCHA Enterprise.
if (import.meta.env.MODE === "development") {
  const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined;
  if (debugToken) (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
}

initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(need("VITE_RECAPTCHA_SITE_KEY")),
  isTokenAutoRefreshEnabled: true,
});

export const ai = getAI(app, { backend: new GoogleAIBackend() });
