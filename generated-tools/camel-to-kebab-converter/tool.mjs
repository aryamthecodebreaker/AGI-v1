export async function run(input) {
  function convertKeys(value) {
    if (Array.isArray(value)) {
      return value.map(convertKeys);
    }
    if (value && typeof value === 'object') {
      const result = {};
      for (const [key, val] of Object.entries(value)) {
        const kebabKey = key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        result[kebabKey] = convertKeys(val);
      }
      return result;
    }
    return value;
  }
  return convertKeys(input);
}