import { Buffer } from 'node:buffer';

/**
 * Validates that a string does not contain lone surrogates (RFC 8785 Section 3.2.2.2).
 * @param {string} str
 */
function validateNoLoneSurrogates(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate
      if (i + 1 >= str.length) {
        throw new Error('Lone high surrogate detected at the end of the string');
      }
      const nextCode = str.charCodeAt(i + 1);
      if (nextCode < 0xdc00 || nextCode > 0xdfff) {
        throw new Error('Lone high surrogate detected');
      }
      i++; // Skip low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate without preceding high surrogate
      throw new Error('Lone low surrogate detected');
    }
  }
}

/**
 * Serializes a string according to RFC 8785 Section 3.2.2.2.
 * @param {string} str
 * @returns {string}
 */
function serializeString(str) {
  validateNoLoneSurrogates(str);
  let result = '"';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const code = str.charCodeAt(i);
    if (char === '"') {
      result += '\\"';
    } else if (char === '\\') {
      result += '\\\\';
    } else if (char === '\b') {
      result += '\\b';
    } else if (char === '\f') {
      result += '\\f';
    } else if (char === '\n') {
      result += '\\n';
    } else if (char === '\r') {
      result += '\\r';
    } else if (char === '\t') {
      result += '\\t';
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // Control characters and U+007F to U+009F must be escaped as \uHHHH
      result += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      result += char;
    }
  }
  result += '"';
  return result;
}

/**
 * Serializes a number according to RFC 8785 Section 3.2.2.3.
 * @param {number} num
 * @returns {string}
 */
function serializeNumber(num) {
  if (!Number.isFinite(num)) {
    throw new Error('NaN and Infinity are not supported in JCS');
  }
  if (Object.is(num, -0)) {
    return '-0';
  }
  
  // Use ES6 Number.prototype.toString() as the baseline, but format exponential notation correctly
  const str = num.toString();
  if (str.includes('e')) {
    // Normalize exponential notation (e.g., 1e+23 -> 1e23)
    return str.replace('e+', 'e');
  }
  return str;
}

/**
 * Compares two strings by their UTF-16 code units (RFC 8785 Section 3.2.3).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareKeys(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const codeA = a.charCodeAt(i);
    const codeB = b.charCodeAt(i);
    if (codeA !== codeB) {
      return codeA - codeB;
    }
  }
  return a.length - b.length;
}

/**
 * Recursively serializes any value to JCS format.
 * @param {any} val
 * @returns {string}
 */
function serialize(val) {
  if (val === null) {
    return 'null';
  }
  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }
  if (typeof val === 'number') {
    return serializeNumber(val);
  }
  if (typeof val === 'string') {
    return serializeString(val);
  }
  
  // Handle custom toJSON() if present
  if (val && typeof val.toJSON === 'function') {
    return serialize(val.toJSON());
  }

  if (Array.isArray(val)) {
    const items = val.map(item => serialize(item));
    return '[' + items.join(',') + ']';
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val);
    // Sort keys according to UTF-16 code unit order
    keys.sort(compareKeys);
    const parts = keys.map(key => {
      const serializedKey = serializeString(key);
      const serializedValue = serialize(val[key]);
      return `${serializedKey}:${serializedValue}`;
    });
    return '{' + parts.join(',') + '}';
  }

  throw new Error(`Unsupported type: ${typeof val}`);
}

export async function run(input) {
  if (input === undefined || input === null || typeof input !== 'object') {
    throw new Error('Input must be a JSON object');
  }
  
  // The target value to canonicalize is expected in input.value
  const canonical = serialize(input.value);
  return { canonical };
}