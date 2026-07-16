const MAX_RFC_BYTES = 500_000;
const MAX_RFC_CHARACTERS = 80_000;
const MAX_RFC_REFERENCES = 2;

export interface CapabilityEvidence {
  title: string;
  url: string;
  content: string;
}

type FetchLike = typeof fetch;

export function referencedRfcNumbers(task: string): string[] {
  return [...task.matchAll(/\bRFC[\s-]?(\d{3,5})\b/gi)]
    .map((match) => match[1]!)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, MAX_RFC_REFERENCES);
}

export function requiresOfficialCapabilityEvidence(task: string): boolean {
  return /\bRFC\b/i.test(task);
}

export async function collectCapabilityEvidence(
  task: string,
  fetchImpl: FetchLike = fetch,
): Promise<CapabilityEvidence[]> {
  const rfcNumbers = referencedRfcNumbers(task);
  if (requiresOfficialCapabilityEvidence(task) && rfcNumbers.length === 0) {
    throw new Error('The requested RFC capability must name the RFC number for independent verification');
  }

  const evidence: CapabilityEvidence[] = [];
  for (const rfcNumber of rfcNumbers) {
    const url = `https://www.rfc-editor.org/rfc/rfc${rfcNumber}.txt`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'AGI-v1/0.1 (+https://agi-v1-five.vercel.app)',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Official RFC ${rfcNumber} evidence returned HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_RFC_BYTES) {
      throw new Error(`Official RFC ${rfcNumber} evidence exceeds the verification size limit`);
    }
    const content = (await response.text()).slice(0, MAX_RFC_CHARACTERS);
    if (content.trim().length < 100) {
      throw new Error(`Official RFC ${rfcNumber} evidence was empty or incomplete`);
    }
    evidence.push({
      title: `RFC ${rfcNumber}`,
      url,
      content,
    });
  }
  return evidence;
}
