export async function run(input) {
  const { value } = input;
  if (typeof value !== 'number' || value < 1 || value > 3999 || !Number.isInteger(value)) {
    throw new Error('Input must be an integer between 1 and 3999');
  }

  const mapping = [
    { val: 1000, sym: 'M' },
    { val: 900, sym: 'CM' },
    { val: 500, sym: 'D' },
    { val: 400, sym: 'CD' },
    { val: 100, sym: 'C' },
    { val: 90, sym: 'XC' },
    { val: 50, sym: 'L' },
    { val: 40, sym: 'XL' },
    { val: 10, sym: 'X' },
    { val: 9, sym: 'IX' },
    { val: 5, sym: 'V' },
    { val: 4, sym: 'IV' },
    { val: 1, sym: 'I' }
  ];

  let result = '';
  let remaining = value;

  for (const { val, sym } of mapping) {
    while (remaining >= val) {
      result += sym;
      remaining -= val;
    }
  }

  return { roman: result };
}