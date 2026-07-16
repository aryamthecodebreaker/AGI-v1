const STRUCTURAL_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'can',
  'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'i',
  'in', 'is', 'it', 'may', 'me', 'might', 'must', 'my', 'of', 'on', 'or',
  'our', 'should', 'that', 'the', 'their', 'them', 'these', 'they', 'this',
  'those', 'to', 'us', 'user', 'users', 'was', 'we', 'were', 'will', 'with',
  'would', 'you', 'your',
]);

function tokenForms(token: string): Set<string> {
  const forms = new Set([token]);
  if (token.length > 4 && token.endsWith('ies')) forms.add(`${token.slice(0, -3)}y`);
  if (token.length > 3 && token.endsWith('s')) forms.add(token.slice(0, -1));
  return forms;
}

export function contentTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STRUCTURAL_TOKENS.has(token));
}

export function contentIsGroundedInText(value: string, sourceText: string): boolean {
  const required = contentTokens(value);
  if (required.length === 0) return false;
  const sourceForms = new Set(
    contentTokens(sourceText).flatMap((token) => [...tokenForms(token)]),
  );
  return required.every((token) =>
    [...tokenForms(token)].some((form) => sourceForms.has(form)));
}

export function isFactGroundedInUserMessage(fact: string, userMessage: string): boolean {
  return contentIsGroundedInText(fact, userMessage);
}
