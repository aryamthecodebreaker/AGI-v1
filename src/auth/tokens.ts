import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface TokenPayload {
  sub: string; // user id
  iat?: number;
  exp?: number;
}

const EXPIRES_IN = '30d';

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId } satisfies TokenPayload, config.jwtSecret, {
    expiresIn: EXPIRES_IN,
    algorithm: 'HS256',
  });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || !decoded || typeof decoded.sub !== 'string') return null;
    return decoded as TokenPayload;
  } catch {
    return null;
  }
}
