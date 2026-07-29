// Input validation and normalization. All user input crosses this boundary
// before touching business logic or storage.
import { ValidationError } from '../core/errors.js';
import { config } from '../config/config.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/;

export function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return body;
}

export function cleanString(value, { field, maxLength = 256, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required.`, { field });
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`, { field });
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${field} is required.`, { field });
  if (trimmed.length > maxLength) throw new ValidationError(`${field} must be at most ${maxLength} characters.`, { field });
  return trimmed;
}

export function normalizeEmail(value, { required = true } = {}) {
  const email = cleanString(value, { field: 'Email', maxLength: 254, required }).toLowerCase();
  if (!email && !required) return '';
  if (!EMAIL_PATTERN.test(email)) throw new ValidationError('Enter a valid email address.', { field: 'email' });
  return email;
}

export function normalizeUsername(value) {
  const username = cleanString(value, { field: 'User name', maxLength: 32 }).toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new ValidationError('User name must be 3-32 characters using letters, numbers, dots, dashes, or underscores, and start/end with a letter or number.', { field: 'username' });
  }
  return username;
}

export function normalizeDisplayName(value) {
  const name = cleanString(value, { field: 'Name', maxLength: 80 });
  // Strip control characters; keep international names intact.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '');
}

// Length is the only requirement: no complexity rules, no common-password
// deny-list, no restriction on reusing the user name or email. The upper bound
// stays because scrypt cost scales with input size, so an unbounded password
// is a denial-of-service vector rather than a strength question.
export function validatePassword(password) {
  if (typeof password !== 'string') throw new ValidationError('Password is required.', { field: 'password' });
  if (password.length < config.password.minLength) {
    throw new ValidationError(`Password must be at least ${config.password.minLength} characters.`, { field: 'password' });
  }
  if (password.length > config.password.maxLength) {
    throw new ValidationError(`Password must be at most ${config.password.maxLength} characters.`, { field: 'password' });
  }
  return password;
}

export function requireVerificationCode(value) {
  const code = cleanString(value, { field: 'Verification code', maxLength: 12 });
  if (!new RegExp(`^\\d{${config.verification.codeLength}}$`).test(code)) {
    throw new ValidationError(`Enter the ${config.verification.codeLength}-digit code from your email.`, { field: 'code' });
  }
  return code;
}
