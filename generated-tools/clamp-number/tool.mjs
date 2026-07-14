export async function run(input) {
  const { value, min, max } = input;
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('Non-finite number');
  }
  return Math.min(Math.max(value, min), max);
}