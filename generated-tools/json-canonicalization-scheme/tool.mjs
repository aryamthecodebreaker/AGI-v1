export async function run(input) {
  const data = input.data;

  function serialize(val) {
    if (val === null) return 'null';
    if (typeof val === 'boolean') return val ? 'true' : 'false';

    if (typeof val === 'number') {
      if (!Number.isFinite(val)) throw new Error('Invalid number');
      // RFC 8785 requires specific number formatting (ES6+ JSON.stringify is mostly compliant)
      // but we must ensure no scientific notation for integers and specific precision.
      // Standard JSON.stringify in modern V8/Node engines follows the required 754 conversion.
      return JSON.stringify(val);
    }

    if (typeof val === 'string') {
      return JSON.stringify(val);
    }

    if (Array.isArray(val)) {
      const parts = val.map(item => serialize(item));
      return '[' + parts.join(',') + ']';
    }

    if (typeof val === 'object') {
      const keys = Object.keys(val).sort((a, b) => {
        // RFC 8785: Sort keys by UTF-16 code unit values
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const parts = keys.map(key => {
        return serialize(key) + ':' + serialize(val[key]);
      });
      return '{' + parts.join(',') + '}';
    }

    return '';
  }

  return {
    canonicalString: serialize(data)
  };
}