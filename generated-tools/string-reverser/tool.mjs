export async function run(input) {
  const { text } = input;
  if (typeof text !== 'string') {
    throw new Error('Input property "text" must be a string.');
  }
  // Array.from handles multi-byte Unicode characters (like emojis) correctly
  const reversed = Array.from(text).reverse().join('');
  return { reversed };
}