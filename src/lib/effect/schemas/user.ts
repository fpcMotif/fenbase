import { type EffectResult, succeed, fail, type ValidationError } from '../client';

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly role: string;
}

export interface AuthSession {
  readonly token: string;
  readonly user: User;
  readonly expiresAt: number;
}

export interface AuthFailureError {
  readonly _tag: 'AuthFailureError';
  readonly reason: 'INVALID_CREDENTIALS' | 'USER_NOT_FOUND' | 'SESSION_EXPIRED' | 'UNAUTHORIZED';
  readonly message: string;
}

export type AuthError = AuthFailureError | ValidationError;

export function validateEmail(email: string): EffectResult<string, ValidationError> {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return fail({
      _tag: 'ValidationError',
      field: 'email',
      message: 'Invalid email address format',
    });
  }
  return succeed(email);
}

export function validateUser(user: Partial<User>): EffectResult<User, ValidationError> {
  if (!user.id) {
    return fail({
      _tag: 'ValidationError',
      field: 'id',
      message: 'User ID is required',
    });
  }
  if (!user.email) {
    return fail({
      _tag: 'ValidationError',
      field: 'email',
      message: 'User email is required',
    });
  }
  const emailRes = validateEmail(user.email);
  if (emailRes._tag === 'Failure') {
    return emailRes;
  }
  return succeed({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role ?? 'member',
  });
}
