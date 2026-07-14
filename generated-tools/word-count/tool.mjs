export async function run(input) {
  const words = input.text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}
