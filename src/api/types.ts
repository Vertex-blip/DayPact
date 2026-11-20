export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_WEB_API_KEY: string;
  APP_ORIGIN: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  TURNSTILE_SECRET?: string;
  ADMIN_OWNER_UID?: string;
  ADMIN_FIREBASE_CLIENT_EMAIL?: string;
  ADMIN_FIREBASE_PRIVATE_KEY?: string;
  ADMIN_TOTP_KEY?: string;
}
export interface Identity {
  uid: string;
  email: string;
  name?: string;
  authTime: number;
  token: string;
}
export type Authenticator = (request: Request, env: Env) => Promise<Identity>;
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
