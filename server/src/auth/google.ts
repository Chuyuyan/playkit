import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.ts';

// Google publishes the public keys used to sign ID tokens. `jose` caches and
// refreshes this for us, so verification is a local signature check.
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
}

/**
 * Verifies a Google ID token: signature, issuer, audience (our client ID), and
 * expiry are all checked by `jwtVerify`. Returns null on any failure — callers
 * should treat that as "sign-in failed" without further detail.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile | null> {
  try {
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: config.googleClientId,
    });

    const email = typeof payload.email === 'string' ? payload.email : '';
    // An unverified Google email must not be trusted — it would let someone
    // claim an address they don't control and take over a password account.
    if (!email || payload.email_verified !== true) return null;
    if (!payload.sub) return null;

    return {
      sub: payload.sub,
      email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  } catch {
    return null;
  }
}
